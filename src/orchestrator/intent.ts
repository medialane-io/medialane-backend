// SNIP-12 typed data builders — verified against Cairo contract types.cairo
import type { TypedData } from "starknet";
import { Contract, num, cairo } from "starknet";
import { createProvider, normalizeAddress } from "../utils/starknet.js";
import { IPMarketplaceABI } from "../config/abis.js";
import { MARKETPLACE_CONTRACT, COLLECTION_CONTRACT, getChainId, getTokenByAddress } from "../config/constants.js";
import type {
  CreateListingIntentBody,
  MakeOfferIntentBody,
  FulfillOrderIntentBody,
  CancelOrderIntentBody,
  MintIntentBody,
  CreateCollectionIntentBody,
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
  const provider = createProvider();
  const contract = new Contract(IPMarketplaceABI as any, MARKETPLACE_CONTRACT, provider);
  const nonce = await contract.nonces(normalizeAddress(address));
  return nonce.toString();
}

function generateSalt(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function resolveCollectionContract(override?: string): string {
  return override ? normalizeAddress(override) : COLLECTION_CONTRACT;
}

/** Convert a human-readable amount (e.g. "1.5") to raw token units as BigInt. */
function parseAmount(humanAmount: string, decimals: number): bigint {
  const parts = humanAmount.replace(/,/g, "").split(".");
  const integer = BigInt(parts[0] || "0");
  const fraction = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return integer * BigInt(10 ** decimals) + BigInt(fraction);
}

export async function buildCreateListingIntent(body: CreateListingIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);

  const nonce = await fetchNonce(body.offerer);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();

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
      calldata: [MARKETPLACE_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: MARKETPLACE_CONTRACT,
      entrypoint: "register_order",
      calldata: [], // populated client-side after signature
    },
  ];

  return { typedData, calls, orderParams };
}

export async function buildMakeOfferIntent(body: MakeOfferIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);

  const nonce = await fetchNonce(body.offerer);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();

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
      item_type: "ERC721",
      token: toHex(body.nftContract),
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex("1"),
      end_amount: toHex("1"),
      recipient: toHex(body.offerer),
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

  // approve(marketplace, amount as u256)
  const priceUint256 = cairo.uint256(priceWei);
  const calls = [
    {
      contractAddress: body.currency,
      entrypoint: "approve",
      calldata: [MARKETPLACE_CONTRACT, priceUint256.low.toString(), priceUint256.high.toString()],
    },
    {
      contractAddress: MARKETPLACE_CONTRACT,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}

export async function buildFulfillOrderIntent(body: FulfillOrderIntentBody) {
  const nonce = await fetchNonce(body.fulfiller);
  const chainId = getChainId();

  const fulfillment = {
    order_hash: toHex(body.orderHash),
    fulfiller: toHex(body.fulfiller),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: FULFILLMENT_TYPES,
    primaryType: "OrderFulfillment",
    domain: { ...DOMAIN, chainId },
    message: fulfillment,
  };

  // Fetch order to know what ERC20 to approve
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const calls: { contractAddress: string; entrypoint: string; calldata: string[] }[] = [];

  if (order?.considerationToken && order?.considerationStartAmount) {
    const amountUint256 = cairo.uint256(order.considerationStartAmount);
    calls.push({
      contractAddress: order.considerationToken,
      entrypoint: "approve",
      calldata: [MARKETPLACE_CONTRACT, amountUint256.low.toString(), amountUint256.high.toString()],
    });
  }

  calls.push({
    contractAddress: MARKETPLACE_CONTRACT,
    entrypoint: "fulfill_order",
    calldata: [],
  });

  return { typedData, calls, fulfillment };
}

export async function buildCancelOrderIntent(body: CancelOrderIntentBody) {
  const nonce = await fetchNonce(body.offerer);
  const chainId = getChainId();

  const cancelation = {
    order_hash: toHex(body.orderHash),
    offerer: toHex(body.offerer),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: CANCELLATION_TYPES,
    primaryType: "OrderCancellation",
    domain: { ...DOMAIN, chainId },
    message: cancelation,
  };

  const calls = [
    {
      contractAddress: MARKETPLACE_CONTRACT,
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
  const provider = createProvider();
  const ownershipResult = await provider.callContract({
    contractAddress: contract,
    entrypoint: "is_collection_owner",
    calldata: [id.low.toString(), id.high.toString(), owner],
  });
  if (ownershipResult[0] === "0x0") {
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
