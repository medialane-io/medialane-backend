// Intent builders. SNIP-12 typed-data shapes live in @medialane/sdk
// (src/marketplace/signing.ts) — the protocol's single source of truth.
// The 2026-04-28 V2 incident was caused by two divergent copies; never
// re-declare these in this file.
import type { TypedData } from "starknet";
import { cairo, hash, num, Contract, CairoOption, CairoOptionVariant } from "starknet";
import { callRpc, normalizeAddress, createProvider } from "../utils/starknet.js";
import {
  STARKNET_MARKETPLACE_721_CONTRACT, STARKNET_MARKETPLACE_1155_CONTRACT, STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_COLLECTION_1155_CONTRACT, STARKNET_IP_TICKETS_FACTORY_CONTRACT, STARKNET_IP_CLUB_FACTORY_CONTRACT,
  STARKNET_IP_SPONSORSHIP_CONTRACT, STARKNET_POP_FACTORY_CONTRACT, STARKNET_DROP_FACTORY_CONTRACT,
  getChainId, getTokenByAddress,
} from "../config/constants.js";
import { postRpc } from "../utils/rpcFetch.js";
import {
  buildOrderTypedData,
  build1155OrderTypedData,
  buildCancellationTypedData,
  build1155CancellationTypedData,
  IPCollection1155FactoryABI,
  IPCollection1155ABI,
  IPTicketCollectionFactoryABI,
  IPTicketCollectionABI,
  IPClubFactoryABI,
  IPClubCollectionABI,
  IPSponsorshipABI,
  POPFactoryABI,
  DropFactoryABI,
  toDropContractConditions,
  buildCreateCreatorCoinCall,
  buildLaunchOnEkuboCalls,
} from "@medialane/sdk/starknet";
import type { PopEventType } from "@medialane/sdk";
import type {
  CreateListingIntentBody,
  MakeOfferIntentBody,
  FulfillOrderIntentBody,
  CancelOrderIntentBody,
  MintIntentBody,
  CreateCollectionIntentBody,
  CreateTierIntentBody,
  CounterOfferIntentBody,
  CreateSponsorshipOfferIntentBody,
  SetSponsorshipOfferOpenIntentBody,
  PlaceSponsorshipBidIntentBody,
  RetractSponsorshipBidIntentBody,
  AcceptSponsorshipBidIntentBody,
  CreateSponsorshipProposalIntentBody,
  WithdrawSponsorshipProposalIntentBody,
  AcceptSponsorshipProposalIntentBody,
  RejectSponsorshipProposalIntentBody,
  CreateCoinIntentBody,
  LaunchCoinIntentBody,
} from "../types/api.js";
import prisma from "../db/client.js";
import { uploadJson } from "./metadataPin.js";
import { resolveServiceForContract } from "../utils/collection.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("intent");

const GET_COUNTER_SELECTOR = hash.getSelectorFromName("get_counter");
const ROYALTY_INFO_SELECTOR = hash.getSelectorFromName("royalty_info");

async function fetchCounter1155(address: string): Promise<string> {
  return fetchCounterFromContract(STARKNET_MARKETPLACE_1155_CONTRACT, address);
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

async function fetchCounter(address: string): Promise<string> {
  return fetchCounterFromContract(STARKNET_MARKETPLACE_721_CONTRACT, address);
}

async function fetchCounterFromContract(contractAddress: string, address: string): Promise<string> {
  const { result } = await postRpc<string[]>(
    {
      jsonrpc: "2.0",
      method: "starknet_call",
      params: {
        request: {
          contract_address: contractAddress,
          entry_point_selector: GET_COUNTER_SELECTOR,
          calldata: [normalizeAddress("STARKNET", address)],
        },
        block_id: "latest",
      },
      id: 1,
    },
    { contractAddress },
  );
  if (!result?.[0]) throw new Error("Counter RPC returned no result");
  return BigInt(result[0]).toString();
}

/**
 * Signed EIP-2981 royalty cap (bps) for an NFT, read live via
 * royalty_info(tokenId, 10000) — the returned amount equals the bps at
 * salePrice 10000. Any non-2981 NFT or RPC failure yields "0" (no royalty —
 * never over-pay). Mirrors the SDK's resolveRoyaltyMaxBps.
 */
async function fetchRoyaltyMaxBps(nftContract: string, tokenId: string): Promise<string> {
  const id = cairo.uint256(tokenId);
  const calldata = [id.low.toString(), id.high.toString(), "10000", "0"];
  try {
    const { result } = await postRpc<string[]>(
      {
        jsonrpc: "2.0",
        method: "starknet_call",
        params: {
          request: {
            contract_address: normalizeAddress("STARKNET", nftContract),
            entry_point_selector: ROYALTY_INFO_SELECTOR,
            calldata,
          },
          block_id: "latest",
        },
        id: 1,
      },
      { nftContract },
    );
    // result = [receiver, amount.low, amount.high]; amount == bps at salePrice 10000
    if (result?.[1] !== undefined) return BigInt(result[1]).toString();
  } catch {
    // non-2981 NFT or RPC failure — fall through to "0" (never over-pay)
  }
  return "0";
}


interface OrderLegInput {
  itemType: string;
  token: string;
  identifierOrCriteria: string | number | bigint;
  amount: string | number | bigint;
  recipient?: string;
}

/**
 * Assembles the `OrderParameters` object literal shared by every SNIP-12
 * order (listing, offer, counter-offer). The typed-data SHAPE (domain,
 * field order) is the SDK's `buildOrderTypedData`/`build1155OrderTypedData`
 * — this only DRYs the near-identical field-population block that used to
 * be repeated at each call site in this file.
 */
export function buildOrderParams(input: {
  offerer: string;
  marketplace: string;
  offer: OrderLegInput;
  consideration: OrderLegInput;
  royaltyMaxBps: string | number | bigint;
  startTime: number;
  endTime: number;
  salt: string;
  counter: string;
}) {
  return {
    offerer: toHex(input.offerer),
    marketplace: toHex(input.marketplace),
    offer: {
      item_type: input.offer.itemType,
      token: toHex(input.offer.token),
      identifier_or_criteria: toHex(input.offer.identifierOrCriteria),
      amount: toHex(input.offer.amount),
    },
    consideration: {
      item_type: input.consideration.itemType,
      token: toHex(input.consideration.token),
      identifier_or_criteria: toHex(input.consideration.identifierOrCriteria),
      amount: toHex(input.consideration.amount),
      recipient: toHex(input.consideration.recipient ?? ""),
    },
    royalty_max_bps: toHex(input.royaltyMaxBps),
    start_time: toHex(input.startTime),
    end_time: toHex(input.endTime),
    salt: toHex(input.salt),
    counter: toHex(input.counter),
  };
}

function generateSalt(): string {
  // 248-bit: salt is the sole order-hash uniqueness source now that nonce is gone.
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function resolveCollectionContract(override?: string): string {
  return override ? normalizeAddress("STARKNET", override) : STARKNET_COLLECTION_721_CONTRACT;
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
  const counter = await fetchCounter1155(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);

  const orderParams = buildOrderParams({
    offerer: body.offerer,
    marketplace: STARKNET_MARKETPLACE_1155_CONTRACT,
    offer: { itemType: "ERC1155", token: body.nftContract, identifierOrCriteria: body.tokenId, amount },
    consideration: { itemType: "ERC20", token: body.currency, identifierOrCriteria: "0", amount: priceWei, recipient: body.offerer },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime: body.endTime,
    salt,
    counter,
  });

  const typedData: TypedData = build1155OrderTypedData(orderParams, chainId);

  // set_approval_for_all(marketplace_1155, true) + register_order(flat_order, signature)
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "set_approval_for_all",
      calldata: [STARKNET_MARKETPLACE_1155_CONTRACT, "0x1"],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_1155_CONTRACT,
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
  const counter = await fetchCounter(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);

  // 30s buffer on start_time — enough for tx inclusion on Starknet (~6s blocks)
  const orderParams = buildOrderParams({
    offerer: body.offerer,
    marketplace: STARKNET_MARKETPLACE_721_CONTRACT,
    offer: { itemType: "ERC721", token: body.nftContract, identifierOrCriteria: body.tokenId, amount: "1" },
    consideration: { itemType: "ERC20", token: body.currency, identifierOrCriteria: "0", amount: priceWei, recipient: body.offerer },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime: body.endTime,
    salt,
    counter,
  });

  const typedData: TypedData = buildOrderTypedData(orderParams, chainId);

  // approve(marketplace, tokenId as u256)
  const tokenIdUint256 = cairo.uint256(body.tokenId);
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [STARKNET_MARKETPLACE_721_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_721_CONTRACT,
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
  const counter = is1155 ? await fetchCounter1155(body.offerer) : await fetchCounter(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;
  const quantity = is1155 ? BigInt(body.quantity ?? "1") : 1n;
  if (quantity < 1n) throw new Error("quantity must be at least 1");

  // 30s buffer on start_time — enough for tx inclusion on Starknet (~6s blocks)
  const orderParams = buildOrderParams({
    offerer: body.offerer,
    marketplace: marketplaceContract,
    offer: { itemType: "ERC20", token: body.currency, identifierOrCriteria: "0", amount: priceWei },
    consideration: {
      itemType: is1155 ? "ERC1155" : "ERC721",
      token: body.nftContract,
      identifierOrCriteria: body.tokenId,
      amount: quantity,
      recipient: body.offerer,
    },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime: body.endTime,
    salt,
    counter,
  });

  const typedData: TypedData = is1155
    ? build1155OrderTypedData(orderParams, chainId)
    : buildOrderTypedData(orderParams, chainId);

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
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;

  // Fulfilment is unsigned — the caller IS the fulfiller (audit F3). No SNIP-12,
  // no nonce. For ERC-1155 the buyer's chosen unit quantity defaults to 1.
  const quantity1155 = is1155 ? BigInt(body.quantity ?? "1") : 1n;

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
    // 721: fulfill_order(order_hash); 1155: fulfill_order(order_hash, quantity)
    calldata: is1155
      ? [toHex(body.orderHash), toHex(quantity1155)]
      : [toHex(body.orderHash)],
  });

  return { calls };
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
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;

  const cancelation = {
    order_hash: toHex(body.orderHash),
    offerer: toHex(body.offerer),
  };

  const typedData: TypedData = is1155
    ? build1155CancellationTypedData(cancelation, chainId)
    : buildCancellationTypedData(cancelation, chainId);

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
 * The per-creator-factory services (as opposed to mip-erc721/ip-erc721's
 * shared registry). Each deploys its own contract per creator via a factory,
 * and each collection is a plain OZ `Ownable` — owner is a direct `owner()`
 * read, not a registry `is_collection_owner(id, owner)` lookup.
 *
 * The single source for these service IDs — routes (`intents/_shared.ts`
 * zod enums) import the ID tuples from here rather than re-declaring them,
 * so adding a 4th factory-family service is one edit, not two kept in sync
 * by hand.
 */
export const FACTORY_FAMILY_SERVICE_IDS = ["mip-erc1155", "ip-tickets", "ip-club"] as const;
export const TIER_SERVICE_IDS = ["ip-tickets", "ip-club"] as const;
type FactoryFamilyServiceId = typeof FACTORY_FAMILY_SERVICE_IDS[number];

/**
 * pop-protocol/drop-collection are per-creator factory deploys too, but their
 * factories don't share the uniform `deploy_collection(name, symbol, baseUri)`
 * entrypoint the three above do (POP needs a claim deadline + event type;
 * Drop needs a max supply + initial claim conditions) — so they get their own
 * branch in `buildCreateCollectionIntent` below rather than a `FACTORY_FAMILY_SERVICES`
 * entry. This tuple is only the schema enum's single source.
 */
export const COLLECTION_SERVICE_IDS = [...FACTORY_FAMILY_SERVICE_IDS, "pop-protocol", "drop-collection"] as const;

/**
 * ABIs/addresses come straight from the SDK (single source) — the same ones
 * `ERC1155CollectionService`/`TicketService`/`ClubService` use client-side.
 * This backend never signs/executes with them; it only calls `.populate()`
 * to get unsigned calldata, exactly like the registry path already does.
 */
const FACTORY_FAMILY_SERVICES: Record<FactoryFamilyServiceId, { factoryAddress: string; factoryAbi: unknown; collectionAbi: unknown }> = {
  "mip-erc1155": {
    factoryAddress: STARKNET_COLLECTION_1155_CONTRACT,
    factoryAbi: IPCollection1155FactoryABI,
    collectionAbi: IPCollection1155ABI,
  },
  "ip-tickets": {
    factoryAddress: STARKNET_IP_TICKETS_FACTORY_CONTRACT,
    factoryAbi: IPTicketCollectionFactoryABI,
    collectionAbi: IPTicketCollectionABI,
  },
  "ip-club": {
    factoryAddress: STARKNET_IP_CLUB_FACTORY_CONTRACT,
    factoryAbi: IPClubFactoryABI,
    collectionAbi: IPClubCollectionABI,
  },
};

function isFactoryFamilyService(service: string | null): service is FactoryFamilyServiceId {
  return service != null && Object.prototype.hasOwnProperty.call(FACTORY_FAMILY_SERVICES, service);
}

/** Plain OZ `Ownable.owner()` check — the factory-family equivalent of the registry's `is_collection_owner`. */
async function assertFactoryCollectionOwner(collectionAddress: string, expectedOwner: string): Promise<void> {
  const result = await callRpc((provider) => provider.callContract({
    contractAddress: collectionAddress,
    entrypoint: "owner",
    calldata: [],
  }));
  const onChainOwner = normalizeAddress("STARKNET", result[0]);
  if (onChainOwner !== expectedOwner) {
    throw new Error(`Address ${expectedOwner} is not the owner of collection ${collectionAddress}`);
  }
}

/**
 * Build a MINT intent — no SNIP-12 signing required.
 *
 * Dispatches on the target collection's service (resolved from
 * `collectionContract`, same lookup `payments/pricing.ts` uses to price it):
 * mip-erc721/ip-erc721 (default, registry-based) mint a fresh token by
 * `collectionId`; mip-erc1155 mints a NEW edition; ip-tickets/ip-club mint
 * more copies of an EXISTING tier (create one first via CREATE_TIER).
 */
const REGISTRY_COMPATIBLE_SERVICES = new Set(["mip-erc721", "ip-erc721"]);

export async function buildMintIntent(body: MintIntentBody) {
  const owner = normalizeAddress("STARKNET", body.owner);
  const recipient = normalizeAddress("STARKNET", body.recipient);
  const contractAddress = resolveCollectionContract(body.collectionContract);
  const service = body.collectionContract
    ? await resolveServiceForContract(prisma, "STARKNET", contractAddress)
    : "mip-erc721";

  if (isFactoryFamilyService(service)) {
    const family = FACTORY_FAMILY_SERVICES[service];
    if (body.royaltyBps) {
      throw new Error(
        `royaltyBps has no effect on a ${service} mint — set it via ${service === "mip-erc1155" ? "setDefaultRoyalty/setTokenRoyalty" : "CREATE_TIER"} instead.`,
      );
    }
    await assertFactoryCollectionOwner(contractAddress, owner);
    const collection = new Contract(family.collectionAbi as never, contractAddress, createProvider() as never);

    if (service === "mip-erc1155") {
      if (!body.tokenUri || !body.value) {
        throw new Error("tokenUri and value are required to mint a new mip-erc1155 edition");
      }
      const call = collection.populate("mint_edition", [recipient, cairo.uint256(body.value), body.tokenUri]);
      return { calls: [call] };
    }

    // ip-tickets / ip-club: mint copies of an already-created tier.
    if (!body.tokenId || !body.amount) {
      throw new Error(`tokenId and amount are required to mint on ${service} — create the tier first via CREATE_TIER`);
    }
    const call = collection.populate("mint", [recipient, cairo.uint256(body.tokenId), cairo.uint256(body.amount)]);
    return { calls: [call] };
  }

  if (service && !REGISTRY_COMPATIBLE_SERVICES.has(service)) {
    throw new Error(
      `Service "${service}" does not support the intents-based mint flow. Supported: mip-erc721, ip-erc721, ${FACTORY_FAMILY_SERVICE_IDS.join(", ")}.`,
    );
  }

  // Registry mint (mip-erc721 / ip-erc721, or an unindexed/external collectionContract) — unchanged.
  if (!body.collectionId || !body.tokenUri) {
    throw new Error("collectionId and tokenUri are required for a registry mint");
  }
  const id = cairo.uint256(body.collectionId);

  const ownershipResult = await callRpc((provider) => provider.callContract({
    contractAddress,
    entrypoint: "is_collection_owner",
    calldata: [id.low.toString(), id.high.toString(), owner],
  }));
  if (!ownershipResult[0] || BigInt(ownershipResult[0]) === 0n) {
    throw new Error(`Address ${body.owner} is not the owner of collection ${body.collectionId}`);
  }

  // mint(collection_id: u256, recipient, token_uri: ByteArray, royalty_bps: u128) — MIP v0.4.0
  const calldata = [
    id.low.toString(),
    id.high.toString(),
    recipient,
    ...encodeByteArray(body.tokenUri),
    (body.royaltyBps ?? 0).toString(),
  ];
  return { calls: [{ contractAddress, entrypoint: "mint", calldata }] };
}

/**
 * Build a CREATE_COLLECTION intent — no SNIP-12 signing required.
 *
 * `body.service` selects the target: omitted (default) creates a registry
 * entry for mip-erc721/ip-erc721, unchanged from before. One of
 * "mip-erc1155" | "ip-tickets" | "ip-club" deploys a new per-creator
 * contract via that service's factory instead.
 *
 * When no explicit baseUri is provided, builds an ERC-7572-compliant collection
 * metadata JSON and uploads it to Pinata IPFS so the on-chain base_uri resolves
 * to discoverable, standards-compliant metadata (image, name, description).
 * Falls back to empty base_uri gracefully if Pinata is unavailable.
 */
export async function buildCreateCollectionIntent(body: CreateCollectionIntentBody) {
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

  if (isFactoryFamilyService(body.service ?? null)) {
    const family = FACTORY_FAMILY_SERVICES[body.service as FactoryFamilyServiceId];
    const factory = new Contract(family.factoryAbi as never, family.factoryAddress, createProvider() as never);
    const call = factory.populate("deploy_collection", [body.name, body.symbol, baseUri]);
    return { calls: [call] };
  }

  if (body.service === "pop-protocol") {
    if (body.claimEndTimestamp == null || !body.eventType) {
      throw new Error("claimEndTimestamp and eventType are required to deploy a pop-protocol collection");
    }
    const factory = new Contract(POPFactoryABI as never, STARKNET_POP_FACTORY_CONTRACT, createProvider() as never);
    const call = factory.populate("create_collection", [
      body.name,
      body.symbol,
      baseUri,
      body.claimEndTimestamp,
      { [body.eventType as PopEventType]: {} },
    ]);
    return { calls: [call] };
  }

  if (body.service === "drop-collection") {
    if (!body.maxSupply || !body.conditions) {
      throw new Error("maxSupply and conditions are required to deploy a drop-collection");
    }
    const factory = new Contract(DropFactoryABI as never, STARKNET_DROP_FACTORY_CONTRACT, createProvider() as never);
    // Same calldata shape DropService.createDrop uses client-side (single source: SDK's toDropContractConditions).
    const call = factory.populate("create_drop", [
      body.name,
      body.symbol,
      baseUri,
      BigInt(body.maxSupply),
      toDropContractConditions(body.conditions),
    ]);
    return { calls: [call] };
  }

  // Registry create-collection (mip-erc721 / ip-erc721) — unchanged.
  const contract = resolveCollectionContract(body.collectionContract);
  const calldata = [
    ...encodeByteArray(body.name),
    ...encodeByteArray(body.symbol),
    ...encodeByteArray(baseUri),
  ];
  return { calls: [{ contractAddress: contract, entrypoint: "create_collection", calldata }] };
}

/**
 * Build a CREATE_TIER intent — no SNIP-12 signing required.
 *
 * Defines a reusable ticket type (`create_ticket`) or membership tier
 * (`create_membership`) inside an already-deployed ip-tickets/ip-club
 * collection. `MINT` then mints copies of the tier this creates.
 */
export async function buildCreateTierIntent(body: CreateTierIntentBody) {
  if (body.service !== "ip-tickets" && body.service !== "ip-club") {
    throw new Error(`CREATE_TIER is only supported for ip-tickets and ip-club, got "${body.service}"`);
  }
  const family = FACTORY_FAMILY_SERVICES[body.service];

  const collectionAddress = normalizeAddress("STARKNET", body.collection);
  const owner = normalizeAddress("STARKNET", body.owner);
  await assertFactoryCollectionOwner(collectionAddress, owner);

  const collection = new Contract(family.collectionAbi as never, collectionAddress, createProvider() as never);

  const startTime = body.startTime != null
    ? new CairoOption(CairoOptionVariant.Some, body.startTime)
    : new CairoOption(CairoOptionVariant.None);
  const endTime = body.endTime != null
    ? new CairoOption(CairoOptionVariant.Some, body.endTime)
    : new CairoOption(CairoOptionVariant.None);

  const entrypoint = body.service === "ip-tickets" ? "create_ticket" : "create_membership";
  const call = collection.populate(entrypoint, [
    cairo.uint256(body.maxSupply),
    startTime,
    endTime,
    body.royaltyBps,
    body.metadataUri,
  ]);
  return { calls: [call] };
}

/**
 * Build a CREATE_COIN intent — no SNIP-12 signing required.
 *
 * Deploys a fixed-supply CreatorCoin via the Factory (full supply minted to
 * the Factory until launch). Calldata comes from the SDK's account-free
 * `buildCreateCreatorCoinCall` — the same builder both apps' launch flows
 * used to call directly client-side; the backend now sits in front of it so
 * the deploy is metered like every other collection/coin creation.
 */
export async function buildCreateCoinIntent(body: CreateCoinIntentBody) {
  const owner = normalizeAddress("STARKNET", body.owner);
  const call = buildCreateCreatorCoinCall({
    owner,
    name: body.name,
    symbol: body.symbol,
    initialSupply: BigInt(body.initialSupply),
    salt: body.salt ? BigInt(body.salt) : undefined,
  });
  return { calls: [call] };
}

/**
 * Build a LAUNCH_COIN intent — no SNIP-12 signing required.
 *
 * Launches an already-deployed CreatorCoin on Ekubo (owner-only — the
 * contract itself is the authority; an unauthorized caller simply reverts,
 * same as before this routed through the backend). Optionally pre-funds the
 * Factory with quote in the same multicall for the team-allocation buyback.
 * The coin address is only known from the CREATE_COIN receipt, so this is a
 * separate intent built after that tx confirms — same two-step shape as
 * CREATE_TIER → MINT.
 */
export async function buildLaunchCoinIntent(body: LaunchCoinIntentBody) {
  const creatorCoin = normalizeAddress("STARKNET", body.creatorCoin);
  const quoteToken = normalizeAddress("STARKNET", body.quoteToken);
  const calls = buildLaunchOnEkuboCalls({
    creatorCoin,
    quoteToken,
    initialHolders: body.initialHolders.map((h) => normalizeAddress("STARKNET", h)),
    initialHoldersAmounts: body.initialHoldersAmounts.map((a) => BigInt(a)),
    transferRestrictionDelay: body.transferRestrictionDelay,
    maxPercentageBuyLaunch: body.maxPercentageBuyLaunch,
    quoteFundAmount: body.quoteFundAmount ? BigInt(body.quoteFundAmount) : undefined,
  });
  return { calls };
}

/**
 * Build a COUNTER_OFFER intent — a standard ERC721 listing where the seller
 * responds to a buyer's bid with a specific counter price.
 *
 * Key difference from buildCreateListingIntent: priceRaw is already in raw wei
 * (not human-readable), and the currency comes from the original bid's offerToken.
 */
export async function buildCounterOfferIntent(body: CounterOfferIntentBody) {
  const counter = await fetchCounter(body.sellerAddress);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();
  const priceWei = BigInt(body.priceRaw);
  const endTime = Math.floor(Date.now() / 1000) + body.durationSeconds;

  const orderParams = buildOrderParams({
    offerer: body.sellerAddress,
    marketplace: STARKNET_MARKETPLACE_721_CONTRACT,
    offer: { itemType: "ERC721", token: body.nftContract, identifierOrCriteria: body.tokenId, amount: "1" },
    consideration: { itemType: "ERC20", token: body.currencyAddress, identifierOrCriteria: "0", amount: priceWei, recipient: body.sellerAddress },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime,
    salt,
    counter,
  });

  const typedData: TypedData = buildOrderTypedData(orderParams, chainId);

  // approve(marketplace, tokenId as u256)
  const tokenIdUint256 = cairo.uint256(body.tokenId);
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [STARKNET_MARKETPLACE_721_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_721_CONTRACT,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}

// ── IP-Sponsorship intents ──────────────────────────────────────────────────
// None of these need SNIP-12 signing (no order-signing scheme on this
// contract; msg.sender is the account executing the call) — every builder
// below returns fully-populated calls, same shape as buildMintIntent.
// Parameter order/types come straight from the SDK's SponsorshipService
// (src/starknet/services/sponsorship.ts) — the source of truth.

function sponsorshipContract(): Contract {
  return new Contract(IPSponsorshipABI as never, STARKNET_IP_SPONSORSHIP_CONTRACT, createProvider() as never);
}

/** Build a CREATE_SPONSORSHIP_OFFER intent — no SNIP-12 signing required. */
export async function buildCreateSponsorshipOfferIntent(body: CreateSponsorshipOfferIntentBody) {
  const specificSponsor = body.specificSponsor
    ? new CairoOption(CairoOptionVariant.Some, normalizeAddress("STARKNET", body.specificSponsor))
    : new CairoOption(CairoOptionVariant.None);

  const call = sponsorshipContract().populate("create_offer", [
    normalizeAddress("STARKNET", body.nftContract),
    cairo.uint256(body.tokenId),
    cairo.uint256(body.minAmount),
    body.duration,
    normalizeAddress("STARKNET", body.paymentToken),
    body.licenseTermsUri,
    body.transferable,
    cairo.uint256(body.royaltyBps),
    specificSponsor,
  ]);
  return { calls: [call] };
}

/** Build a SET_SPONSORSHIP_OFFER_OPEN intent — toggles bid/acceptance eligibility. Reversible. */
export async function buildSetSponsorshipOfferOpenIntent(body: SetSponsorshipOfferOpenIntentBody) {
  const call = sponsorshipContract().populate("set_offer_open", [
    cairo.uint256(body.offerId),
    body.open,
  ]);
  return { calls: [call] };
}

/**
 * Build a PLACE_SPONSORSHIP_BID intent — a bid is a signal plus an open ERC-20
 * allowance; no tokens move until accept_bid. Bundles the approve, matching
 * the SDK's SponsorshipService.placeBid.
 */
export async function buildPlaceSponsorshipBidIntent(body: PlaceSponsorshipBidIntentBody) {
  const amount = cairo.uint256(body.amount);
  const approveCall = {
    contractAddress: normalizeAddress("STARKNET", body.paymentToken),
    entrypoint: "approve",
    calldata: [STARKNET_IP_SPONSORSHIP_CONTRACT, amount.low.toString(), amount.high.toString()],
  };
  const bidCall = sponsorshipContract().populate("place_bid", [
    cairo.uint256(body.offerId),
    amount,
  ]);
  return { calls: [approveCall, bidCall] };
}

/** Build a RETRACT_SPONSORSHIP_BID intent — sponsor-only, withdraws a standing bid. */
export async function buildRetractSponsorshipBidIntent(body: RetractSponsorshipBidIntentBody) {
  const call = sponsorshipContract().populate("retract_bid", [cairo.uint256(body.offerId)]);
  return { calls: [call] };
}

/**
 * Build an ACCEPT_SPONSORSHIP_BID intent — author-only. Re-verifies IP
 * ownership, settles the sponsor's payment (allowance pull, no escrow), and
 * mints the license atomically, all on-chain. No fee is bundled here — the
 * platform fee is the calling app's responsibility (bundled atomically for
 * starknet's direct signer, charged as a separate post-confirmation
 * transaction for io's non-atomic ChipiPay account), same precedent as
 * buildFulfillOrderIntent.
 */
export async function buildAcceptSponsorshipBidIntent(body: AcceptSponsorshipBidIntentBody) {
  const call = sponsorshipContract().populate("accept_bid", [
    cairo.uint256(body.offerId),
    normalizeAddress("STARKNET", body.sponsor),
  ]);
  return { calls: [call] };
}

/** Build a CREATE_SPONSORSHIP_PROPOSAL intent — sponsor-initiated, symmetric counterpart to an offer. */
export async function buildCreateSponsorshipProposalIntent(body: CreateSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("propose_sponsorship", [
    normalizeAddress("STARKNET", body.nftContract),
    cairo.uint256(body.tokenId),
    cairo.uint256(body.amount),
    body.duration,
    body.validUntil ?? 0,
    normalizeAddress("STARKNET", body.paymentToken),
    body.licenseTermsUri,
    body.transferable,
    cairo.uint256(body.royaltyBps),
  ]);
  return { calls: [call] };
}

/** Build a WITHDRAW_SPONSORSHIP_PROPOSAL intent — proposer-only. */
export async function buildWithdrawSponsorshipProposalIntent(body: WithdrawSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("withdraw_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}

/**
 * Build an ACCEPT_SPONSORSHIP_PROPOSAL intent — asset-owner-only (re-verified
 * on-chain; a proposal binds to the asset, not a person). Settles payment and
 * mints the license atomically, same fee precedent as buildAcceptSponsorshipBidIntent.
 */
export async function buildAcceptSponsorshipProposalIntent(body: AcceptSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("accept_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}

/** Build a REJECT_SPONSORSHIP_PROPOSAL intent — asset-owner-only. */
export async function buildRejectSponsorshipProposalIntent(body: RejectSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("reject_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}
