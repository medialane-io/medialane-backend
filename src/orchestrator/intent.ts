// SNIP-12 typed data builders — verified against Cairo contract types.cairo
import type { TypedData } from "starknet";
import { num, cairo, hash } from "starknet";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import { MARKETPLACE_721_CONTRACT, MARKETPLACE_1155_CONTRACT, COLLECTION_721_CONTRACT, getChainId, getTokenByAddress } from "../config/constants.js";
import { env } from "../config/env.js";
import type {
  CreateListingIntentBody,
  MakeOfferIntentBody,
  FulfillOrderIntentBody,
  CancelOrderIntentBody,
  MintIntentBody,
  CreateCollectionIntentBody,
  CounterOfferIntentBody,
} from "../types/api.js";
import prisma from "../db/client.js";
import { uploadJson } from "./metadataPin.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("intent");

// SNIP-12 type definitions — must exactly match the Cairo StructHash implementations
// in contracts/Medialane-Protocol/src/core/utils.cairo (ORDER_PARAMETERS_TYPE_HASH, etc.)
const SNIP12_TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  OfferItem: [
    { name: "item_type", type: "shortstring" },    // encoded as 'ERC721', 'ERC20', etc.
    { name: "token", type: "ContractAddress" },
    { name: "identifier_or_criteria", type: "felt" },
    { name: "start_amount", type: "felt" },
    { name: "end_amount", type: "felt" },
  ],
  ConsiderationItem: [
    { name: "item_type", type: "shortstring" },
    { name: "token", type: "ContractAddress" },
    { name: "identifier_or_criteria", type: "felt" },
    { name: "start_amount", type: "felt" },
    { name: "end_amount", type: "felt" },
    { name: "recipient", type: "ContractAddress" },
  ],
  OrderParameters: [
    { name: "offerer", type: "ContractAddress" },
    { name: "offer", type: "OfferItem" },
    { name: "consideration", type: "ConsiderationItem" },
    { name: "start_time", type: "felt" },
    { name: "end_time", type: "felt" },
    { name: "salt", type: "felt" },
    { name: "nonce", type: "felt" },
  ],
};

const FULFILLMENT_TYPES = {
  StarknetDomain: SNIP12_TYPES.StarknetDomain,
  OrderFulfillment: [
    { name: "order_hash", type: "felt" },
    { name: "fulfiller", type: "ContractAddress" },
    { name: "nonce", type: "felt" },
  ],
};

const CANCELLATION_TYPES = {
  StarknetDomain: SNIP12_TYPES.StarknetDomain,
  OrderCancellation: [
    { name: "order_hash", type: "felt" },
    { name: "offerer", type: "ContractAddress" },
    { name: "nonce", type: "felt" },
  ],
};

const DOMAIN = { name: "Medialane", version: "1", revision: "1" };

// ─── ERC-1155 Medialane1155 SNIP-12 types ──────────────────────────────────
// The audited ERC-1155 protocol now mirrors the ERC-721 marketplace shape:
// OrderParameters contains nested OfferItem and ConsiderationItem structs.
const SNIP12_TYPES_1155 = { ...SNIP12_TYPES };

const FULFILLMENT_TYPES_1155 = {
  StarknetDomain: SNIP12_TYPES_1155.StarknetDomain,
  OrderFulfillment: [
    { name: "order_hash", type: "felt" },
    { name: "fulfiller", type: "ContractAddress" },
    { name: "quantity", type: "felt" },
    { name: "nonce", type: "felt" },
  ],
};

const CANCELLATION_TYPES_1155 = {
  StarknetDomain: SNIP12_TYPES_1155.StarknetDomain,
  OrderCancellation: [...CANCELLATION_TYPES.OrderCancellation],
};

const DOMAIN_1155 = { name: "Medialane", version: "2", revision: "1" };
const NONCES_SELECTOR = hash.getSelectorFromName("nonces");
const PUBLIC_STARKNET_RPC_FALLBACK = "https://rpc.starknet.lava.build/";

async function fetchNonce1155(address: string): Promise<string> {
  return fetchNonceFromContract(MARKETPLACE_1155_CONTRACT, address);
}

function toHex(value: string | number | bigint): string {
  if (typeof value === "string") {
    if (value.startsWith("0x")) return value;
    try {
      return "0x" + BigInt(value).toString(16);
    } catch {
      return value;
    }
  }
  return "0x" + BigInt(value).toString(16);
}

async function fetchNonce(address: string): Promise<string> {
  return fetchNonceFromContract(MARKETPLACE_721_CONTRACT, address);
}

async function fetchNonceFromContract(contractAddress: string, address: string): Promise<string> {
  const urls = Array.from(new Set([
    env.ALCHEMY_RPC_URL,
    env.STARKNET_RPC_FALLBACK_URL,
    PUBLIC_STARKNET_RPC_FALLBACK,
  ].filter(Boolean) as string[]));
  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      return await fetchNonceFromRpc(url, contractAddress, address);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn({ err: lastError, rpcUrl: sanitizeRpcUrl(url) }, "Nonce RPC failed — trying fallback");
    }
  }

  throw lastError ?? new Error("Nonce RPC failed");
}

async function fetchNonceFromRpc(rpcUrl: string, contractAddress: string, address: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "starknet_call",
      params: {
        request: {
          contract_address: contractAddress,
          entry_point_selector: NONCES_SELECTOR,
          calldata: [normalizeAddress(address)],
        },
        block_id: "latest",
      },
      id: 1,
    }),
  });

  const text = await res.text();
  let json: { result?: string[]; error?: { message?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Nonce RPC returned non-JSON response (${res.status})`);
  }

  if (!res.ok || json.error || !json.result?.[0]) {
    throw new Error(json.error?.message ?? `Nonce RPC failed (${res.status})`);
  }

  return BigInt(json.result[0]).toString();
}

function sanitizeRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid-rpc-url";
  }
}

function generateSalt(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function resolveCollectionContract(override?: string): string {
  return override ? normalizeAddress(override) : COLLECTION_721_CONTRACT;
}

/** Convert a human-readable amount (e.g. "1.5") to raw token units as BigInt. */
function parseAmount(humanAmount: string, decimals: number): bigint {
  const parts = humanAmount.replace(/,/g, "").split(".");
  const integer = BigInt(parts[0] || "0");
  const fraction = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return integer * BigInt(10 ** decimals) + BigInt(fraction);
}

/** Build a CREATE_LISTING intent for an ERC-1155 token. */
async function buildCreateListing1155Intent(body: CreateListingIntentBody & { amount: string }) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);
  const chainId = getChainId();
  const salt = body.salt ?? generateSalt();

  const amount = BigInt(body.amount);
  if (amount < 1n) throw new Error("amount must be at least 1");
  const nonce = await fetchNonce1155(body.offerer);

  const orderParams = {
    offerer: toHex(body.offerer),
    offer: {
      item_type: "ERC1155",
      token: toHex(body.nftContract),
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex(amount),
      end_amount: toHex(amount),
    },
    consideration: {
      item_type: "ERC20",
      token: toHex(body.currency),
      identifier_or_criteria: toHex("0"),
      start_amount: toHex(priceWei),
      end_amount: toHex(priceWei),
      recipient: toHex(body.offerer),
    },
    start_time: toHex(Math.floor(Date.now() / 1000) + 30),
    end_time: toHex(body.endTime),
    salt: toHex(salt),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: SNIP12_TYPES_1155,
    primaryType: "OrderParameters",
    domain: { ...DOMAIN_1155, chainId },
    message: orderParams,
  };

  // set_approval_for_all(marketplace_1155, true) + register_order(flat_order, signature)
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "set_approval_for_all",
      calldata: [MARKETPLACE_1155_CONTRACT, "0x1"],
    },
    {
      contractAddress: MARKETPLACE_1155_CONTRACT,
      entrypoint: "register_order",
      calldata: [], // populated after signature
    },
  ];

  return { typedData, calls, orderParams };
}

/** Build a CREATE_LISTING intent for an ERC-721 token. */
async function buildCreateListing721Intent(body: CreateListingIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);
  const chainId = getChainId();
  const salt = body.salt ?? generateSalt();
  const nonce = await fetchNonce(body.offerer);

  const orderParams = {
    offerer: toHex(body.offerer),
    offer: {
      item_type: "ERC721",               // shortstring — matches ItemType::ERC721.into() in Cairo
      token: toHex(body.nftContract),    // ContractAddress
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex("1"),
      end_amount: toHex("1"),
    },
    consideration: {
      item_type: "ERC20",               // shortstring — matches ItemType::ERC20.into() in Cairo
      token: toHex(body.currency),      // ContractAddress
      identifier_or_criteria: toHex("0"),
      start_amount: toHex(priceWei),
      end_amount: toHex(priceWei),
      recipient: toHex(body.offerer),   // ContractAddress
    },
    start_time: toHex(Math.floor(Date.now() / 1000) + 30), // 30s buffer — enough for tx inclusion on Starknet (~6s blocks)
    end_time: toHex(body.endTime),
    salt: toHex(salt),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: SNIP12_TYPES,
    primaryType: "OrderParameters",
    domain: { ...DOMAIN, chainId },
    message: orderParams,
  };

  // approve(marketplace, tokenId as u256)
  const tokenIdUint256 = cairo.uint256(body.tokenId);
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [MARKETPLACE_721_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: MARKETPLACE_721_CONTRACT,
      entrypoint: "register_order",
      calldata: [], // populated after signature
    },
  ];

  return { typedData, calls, orderParams };
}

/** Dispatch to the correct listing intent builder based on token standard.
 *  Presence of `amount` indicates ERC-1155; absence means ERC-721. */
export async function buildCreateListingIntent(body: CreateListingIntentBody) {
  return body.amount != null
    ? buildCreateListing1155Intent({ ...body, amount: body.amount })
    : buildCreateListing721Intent(body);
}

export async function buildMakeOfferIntent(body: MakeOfferIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);

  const is1155 = body.tokenStandard === "ERC1155";
  const nonce = is1155 ? await fetchNonce1155(body.offerer) : await fetchNonce(body.offerer);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();
  const marketplaceContract = is1155 ? MARKETPLACE_1155_CONTRACT : MARKETPLACE_721_CONTRACT;
  const quantity = is1155 ? BigInt(body.quantity ?? "1") : 1n;
  if (quantity < 1n) throw new Error("quantity must be at least 1");

  const orderParams = {
    offerer: toHex(body.offerer),
    offer: {
      item_type: "ERC20",
      token: toHex(body.currency),
      identifier_or_criteria: toHex("0"),
      start_amount: toHex(priceWei),
      end_amount: toHex(priceWei),
    },
    consideration: {
      item_type: is1155 ? "ERC1155" : "ERC721",
      token: toHex(body.nftContract),
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex(quantity),
      end_amount: toHex(quantity),
      recipient: toHex(body.offerer),
    },
    start_time: toHex(Math.floor(Date.now() / 1000) + 30), // 30s buffer — enough for tx inclusion on Starknet (~6s blocks)
    end_time: toHex(body.endTime),
    salt: toHex(salt),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: is1155 ? SNIP12_TYPES_1155 : SNIP12_TYPES,
    primaryType: "OrderParameters",
    domain: { ...(is1155 ? DOMAIN_1155 : DOMAIN), chainId },
    message: orderParams,
  };

  // approve(marketplace, amount as u256)
  const priceUint256 = cairo.uint256(priceWei);
  const calls = [
    {
      contractAddress: body.currency,
      entrypoint: "approve",
      calldata: [marketplaceContract, priceUint256.low.toString(), priceUint256.high.toString()],
    },
    {
      contractAddress: marketplaceContract,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}

export async function buildFulfillOrderIntent(body: FulfillOrderIntentBody) {
  const chainId = getChainId();

  // Fetch order to determine ERC-721 vs ERC-1155 contract routing.
  // tokenStandard hint from the caller takes precedence — used when the order
  // is not yet in the DB (e.g. listing was created before the indexer caught up).
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const is1155 =
    body.tokenStandard === "ERC1155" ||
    order?.offerItemType === "ERC1155" ||
    order?.considerationItemType === "ERC1155";
  const marketplaceContract = is1155 ? MARKETPLACE_1155_CONTRACT : MARKETPLACE_721_CONTRACT;

  const nonce = is1155
    ? await fetchNonce1155(body.fulfiller)
    : await fetchNonce(body.fulfiller);

  // For ERC-1155: quantity is buyer's chosen units; defaults to 1.
  const quantity1155 = is1155 ? BigInt(body.quantity ?? "1") : 1n;

  const fulfillment = is1155
    ? {
        order_hash: toHex(body.orderHash),
        fulfiller: toHex(body.fulfiller),
        quantity: toHex(quantity1155),
        nonce: toHex(nonce),
      }
    : {
        order_hash: toHex(body.orderHash),
        fulfiller: toHex(body.fulfiller),
        nonce: toHex(nonce),
      };

  const typedData: TypedData = {
    types: is1155 ? FULFILLMENT_TYPES_1155 : FULFILLMENT_TYPES,
    primaryType: "OrderFulfillment",
    domain: { ...(is1155 ? DOMAIN_1155 : DOMAIN), chainId },
    message: fulfillment,
  };

  const calls: { contractAddress: string; entrypoint: string; calldata: string[] }[] = [];

  const offerItemType = order?.offerItemType;
  const considerationItemType = order?.considerationItemType;
  const isListing = offerItemType === "ERC721" || offerItemType === "ERC1155";
  const isOffer = considerationItemType === "ERC721" || considerationItemType === "ERC1155";

  if (isListing && order?.considerationToken && order?.considerationStartAmount) {
    // Buyer fulfills a listing: approve payment token for price_per_unit × quantity.
    // No fee is bundled here — the platform fee is charged by io as a separate
    // post-confirmation transaction (the ChipiPay account is non-atomic, so a
    // bundled fee would stick even when fulfill_order reverts). See
    // medialane-core/docs/specs/2026-05-20-io-verify-then-charge-fee-design.md
    const pricePerUnit = BigInt(order.considerationStartAmount);
    const totalPrice = (pricePerUnit * quantity1155).toString();
    const amountUint256 = cairo.uint256(totalPrice);
    calls.push({
      contractAddress: order.considerationToken,
      entrypoint: "approve",
      calldata: [marketplaceContract, amountUint256.low.toString(), amountUint256.high.toString()],
    });
  } else if (isOffer && order?.considerationToken && order?.considerationIdentifier) {
    // Seller accepts an offer: approve the NFT side to the marketplace.
    if (is1155 || considerationItemType === "ERC1155") {
      calls.push({
        contractAddress: order.considerationToken,
        entrypoint: "set_approval_for_all",
        calldata: [marketplaceContract, "0x1"],
      });
    } else {
      const tokenIdUint256 = cairo.uint256(order.considerationIdentifier);
      calls.push({
        contractAddress: order.considerationToken,
        entrypoint: "approve",
        calldata: [marketplaceContract, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
      });
    }
  }

  calls.push({
    contractAddress: marketplaceContract,
    entrypoint: "fulfill_order",
    calldata: [],
  });

  return { typedData, calls, fulfillment };
}

export async function buildCancelOrderIntent(body: CancelOrderIntentBody) {
  const chainId = getChainId();

  // Fetch order to determine ERC-721 vs ERC-1155 contract routing.
  // tokenStandard hint takes precedence over DB lookup (same as fulfillment).
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const is1155 =
    body.tokenStandard === "ERC1155" ||
    order?.offerItemType === "ERC1155" ||
    order?.considerationItemType === "ERC1155";
  const marketplaceContract = is1155 ? MARKETPLACE_1155_CONTRACT : MARKETPLACE_721_CONTRACT;

  const nonce = is1155
    ? await fetchNonce1155(body.offerer)
    : await fetchNonce(body.offerer);

  const cancelation = {
    order_hash: toHex(body.orderHash),
    offerer: toHex(body.offerer),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: is1155 ? CANCELLATION_TYPES_1155 : CANCELLATION_TYPES,
    primaryType: "OrderCancellation",
    domain: { ...(is1155 ? DOMAIN_1155 : DOMAIN), chainId },
    message: cancelation,
  };

  const calls = [
    {
      contractAddress: marketplaceContract,
      entrypoint: "cancel_order",
      calldata: [] as string[],
    },
  ];

  return { typedData, calls, cancelation };
}

/** Serialize a string as Cairo ByteArray calldata felts.
 *
 * starknet.js's `byteArray.byteArrayFromString` internally calls `encodeShortString`
 * which rejects non-ASCII characters (e.g. accented letters). We implement UTF-8
 * encoding directly: convert to bytes, pack into 31-byte chunks as big-endian felts.
 */
function encodeByteArray(str: string): string[] {
  const bytes = new TextEncoder().encode(str);
  const fullChunks: string[] = [];

  let i = 0;
  while (i + 31 <= bytes.length) {
    let val = 0n;
    for (const b of bytes.slice(i, i + 31)) {
      val = (val << 8n) | BigInt(b);
    }
    fullChunks.push(num.toHex(val));
    i += 31;
  }

  const remaining = bytes.slice(i);
  let pendingVal = 0n;
  for (const b of remaining) {
    pendingVal = (pendingVal << 8n) | BigInt(b);
  }

  return [
    fullChunks.length.toString(),
    ...fullChunks,
    num.toHex(pendingVal),
    remaining.length.toString(),
  ];
}

/**
 * Build a MINT intent — no SNIP-12 signing required.
 * Encodes `mint(collection_id, recipient, token_uri)` calldata against
 * the collection registry contract. Calls are fully populated; the intent
 * is created with status SIGNED.
 */
export async function buildMintIntent(body: MintIntentBody) {
  const contract = resolveCollectionContract(body.collectionContract);
  const id = cairo.uint256(body.collectionId);
  const owner = normalizeAddress(body.owner);

  // Validate that the owner address is actually the collection owner on-chain.
  const ownershipResult = await callRpc((provider) => provider.callContract({
    contractAddress: contract,
    entrypoint: "is_collection_owner",
    calldata: [id.low.toString(), id.high.toString(), owner],
  }));
  if (!ownershipResult[0] || BigInt(ownershipResult[0]) === 0n) {
    throw new Error(`Address ${body.owner} is not the owner of collection ${body.collectionId}`);
  }

  const calldata = [
    id.low.toString(),
    id.high.toString(),
    normalizeAddress(body.recipient),
    ...encodeByteArray(body.tokenUri),
  ];
  return { calls: [{ contractAddress: contract, entrypoint: "mint", calldata }] };
}

/**
 * Build a CREATE_COLLECTION intent — no SNIP-12 signing required.
 * Encodes `create_collection(name, symbol, base_uri)` calldata.
 *
 * When no explicit baseUri is provided, builds an ERC-7572-compliant collection
 * metadata JSON and uploads it to Pinata IPFS so the on-chain base_uri resolves
 * to discoverable, standards-compliant metadata (image, name, description).
 * Falls back to empty base_uri gracefully if Pinata is unavailable.
 */
export async function buildCreateCollectionIntent(body: CreateCollectionIntentBody) {
  const contract = resolveCollectionContract(body.collectionContract);

  let baseUri = body.baseUri || "";

  // Only generate metadata if no explicit baseUri was supplied
  if (!baseUri) {
    try {
      // ERC-7572 / OpenSea contractURI standard — only include fields that have values
      const metadata: Record<string, unknown> = { name: body.name };
      if (body.description) metadata.description = body.description;
      if (body.image) metadata.image = body.image;
      metadata.external_link = "https://medialane.io";

      baseUri = await uploadJson(metadata);
      log.info({ name: body.name, baseUri }, "Collection metadata uploaded to IPFS");
    } catch (err) {
      log.warn({ err }, "Failed to upload collection metadata to IPFS — proceeding with empty base_uri");
    }
  }

  const calldata = [
    ...encodeByteArray(body.name),
    ...encodeByteArray(body.symbol),
    ...encodeByteArray(baseUri),
  ];
  return { calls: [{ contractAddress: contract, entrypoint: "create_collection", calldata }] };
}

/**
 * Build a COUNTER_OFFER intent — a standard ERC721 listing where the seller
 * responds to a buyer's bid with a specific counter price.
 *
 * Key difference from buildCreateListingIntent: priceRaw is already in raw wei
 * (not human-readable), and the currency comes from the original bid's offerToken.
 */
export async function buildCounterOfferIntent(body: CounterOfferIntentBody) {
  const nonce = await fetchNonce(body.sellerAddress);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();
  const priceWei = BigInt(body.priceRaw);
  const endTime = Math.floor(Date.now() / 1000) + body.durationSeconds;

  const orderParams = {
    offerer: toHex(body.sellerAddress),
    offer: {
      item_type: "ERC721",
      token: toHex(body.nftContract),
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex("1"),
      end_amount: toHex("1"),
    },
    consideration: {
      item_type: "ERC20",
      token: toHex(body.currencyAddress),
      identifier_or_criteria: toHex("0"),
      start_amount: toHex(priceWei),
      end_amount: toHex(priceWei),
      recipient: toHex(body.sellerAddress),
    },
    start_time: toHex(Math.floor(Date.now() / 1000) + 30),
    end_time: toHex(endTime),
    salt: toHex(salt),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: SNIP12_TYPES,
    primaryType: "OrderParameters",
    domain: { ...DOMAIN, chainId },
    message: orderParams,
  };

  // approve(marketplace, tokenId as u256)
  const tokenIdUint256 = cairo.uint256(body.tokenId);
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [MARKETPLACE_721_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: MARKETPLACE_721_CONTRACT,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}
