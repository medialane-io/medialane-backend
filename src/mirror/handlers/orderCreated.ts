import { Contract, hash, num } from "starknet";
import { type Chain, type Prisma } from "@prisma/client";
import { IPMarketplaceABI } from "@medialane/sdk";
import { env } from "../../config/env.js";
import {
  MARKETPLACE_721_CONTRACT,
  MARKETPLACE_1155_CONTRACT,
  getTokenByAddress,
} from "../../config/constants.js";
import { callRpc, decodeShortstring, normalizeAddress } from "../../utils/starknet.js";
import { ensureCollectionFromActivity } from "../../utils/collection.js";
import { formatAmount } from "../../utils/bigint.js";
import type { ParsedOrderCreated, OnChainOrderDetails } from "../../types/marketplace.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import { createLogger } from "../../utils/logger.js";
import { withRetry } from "../../utils/retry.js";

const log = createLogger("handler:orderCreated");

// ── Shared core ────────────────────────────────────────────────────────────────

/**
 * Apply a parsed order's on-chain details to the DB. Shared between
 * the ERC-721 and ERC-1155 entry points — they only differ in how they
 * fetch + parse `details`. Everything downstream (price derivation,
 * upsert shape, counter-offer linkage, Collection/Token bootstrap) is
 * identical.
 */
async function applyOrderCreated(
  tx: Prisma.TransactionClient,
  chain: Chain,
  params: {
    orderHash: string;
    details: OnChainOrderDetails;
    blockNumber: bigint;
    txHash: string;
    marketplaceContract: string;
  },
): Promise<string | null> {
  const { orderHash, details, blockNumber, txHash, marketplaceContract } = params;

  // Listing: NFT on offer side, ERC-20 price on consideration side.
  // Bid: ERC-20 price on offer side, NFT on consideration side.
  const isListing = details.offerItemType === "ERC721" || details.offerItemType === "ERC1155";
  const isBid = details.considerationItemType === "ERC721" || details.considerationItemType === "ERC1155";
  const priceTokenAddress = isBid ? details.offerToken : details.considerationToken;
  const priceRaw = isBid ? details.offerStartAmount : details.considerationStartAmount;
  const token = getTokenByAddress(priceTokenAddress);
  const priceFormatted = token ? formatAmount(priceRaw, token.decimals) : priceRaw;
  const currencySymbol = token?.symbol ?? null;
  const nftContract = isListing
    ? details.offerToken
    : isBid
    ? details.considerationToken
    : null;
  const nftTokenId = isListing
    ? details.offerIdentifier
    : isBid
    ? details.considerationIdentifier
    : null;

  await tx.order.upsert({
    where: { chain_orderHash: { chain, orderHash } },
    create: {
      chain,
      orderHash,
      offerer: details.offerer,
      offerItemType: details.offerItemType,
      offerToken: details.offerToken,
      offerIdentifier: details.offerIdentifier,
      offerStartAmount: details.offerStartAmount,
      offerEndAmount: details.offerEndAmount,
      considerationItemType: details.considerationItemType,
      considerationToken: details.considerationToken,
      considerationIdentifier: details.considerationIdentifier,
      considerationStartAmount: details.considerationStartAmount,
      considerationEndAmount: details.considerationEndAmount,
      considerationRecipient: details.considerationRecipient,
      startTime: details.startTime,
      endTime: details.endTime,
      status: "ACTIVE",
      createdBlockNumber: blockNumber,
      createdTxHash: txHash,
      nftContract,
      nftTokenId,
      priceRaw,
      priceFormatted,
      currencySymbol,
      marketplaceContract: normalizeAddress(marketplaceContract),
      ...(details.remainingAmount !== undefined ? { remainingAmount: details.remainingAmount } : {}),
    },
    update: {
      offerer: details.offerer,
      offerItemType: details.offerItemType,
      offerToken: details.offerToken,
      offerIdentifier: details.offerIdentifier,
      considerationItemType: details.considerationItemType,
      considerationToken: details.considerationToken,
      considerationIdentifier: details.considerationIdentifier,
      nftContract,
      nftTokenId,
      priceRaw,
      priceFormatted,
      currencySymbol,
      ...(details.remainingAmount !== undefined ? { remainingAmount: details.remainingAmount } : {}),
    },
  });

  // Counter-offer linkage runs for listings of either standard.
  if (isListing && nftContract && nftTokenId) {
    const parentOrderHash = await findCounterOfferParent(tx, details.offerer, nftContract, nftTokenId);
    if (parentOrderHash) {
      await tx.order.update({
        where: { chain_orderHash: { chain, orderHash } },
        data: { parentOrderHash },
      });
      log.info(
        { chain, orderHash, parentOrderHash },
        "Counter-offer order linked to original bid",
      );
    }
  }

  if (nftContract && nftTokenId) {
    const nftStandard = (isListing ? details.offerItemType : details.considerationItemType) as "ERC721" | "ERC1155";
    await ensureCollectionFromActivity(tx, {
      chain,
      contractAddress: nftContract,
      standard: nftStandard,
      blockNumber,
    });

    await tx.token.upsert({
      where: { chain_contractAddress_tokenId: { chain, contractAddress: nftContract, tokenId: nftTokenId } },
      create: { chain, contractAddress: nftContract, tokenId: nftTokenId, metadataStatus: "PENDING" },
      update: {},
    });
  }

  log.debug({ chain, orderHash, nftContract, nftTokenId }, "Order created");
  return nftContract;
}

async function findCounterOfferParent(
  tx: Prisma.TransactionClient,
  offerer: string,
  nftContract: string,
  nftTokenId: string,
): Promise<string | null> {
  const intents = await tx.transactionIntent.findMany({
    where: {
      type: "COUNTER_OFFER",
      requester: offerer,
      status: { in: ["SIGNED", "CONFIRMED"] },
      parentOrderHash: { not: null },
    },
    select: { parentOrderHash: true },
  });
  if (!intents.length) return null;

  const parentHashes = intents.map((i) => i.parentOrderHash!);
  const originalOrder = await tx.order.findFirst({
    where: { orderHash: { in: parentHashes }, nftContract, nftTokenId },
    select: { orderHash: true },
  });
  return originalOrder?.orderHash ?? null;
}

// ── ERC-721 entry ──────────────────────────────────────────────────────────────

export async function handleOrderCreated(
  event: ParsedOrderCreated,
  tx: Prisma.TransactionClient,
  chain: Chain,
): Promise<string | null> {
  let details: OnChainOrderDetails;
  try {
    const raw = await withRetry(
      () => callRpc((provider) => {
        const contract = new Contract(
          IPMarketplaceABI as any,
          MARKETPLACE_721_CONTRACT,
          provider,
        );
        return contract.get_order_details(event.orderHash);
      }),
      3,   // attempts
      500, // base delay ms (500 → 1000 → 2000)
    );
    details = parseOrderDetails721(raw);
  } catch (err) {
    log.error(
      { err, orderHash: event.orderHash },
      "Failed to fetch ERC-721 order details from RPC after retries — order will be missing",
    );
    return null;
  }

  return applyOrderCreated(tx, chain, {
    orderHash: event.orderHash,
    details,
    blockNumber: event.blockNumber,
    txHash: event.txHash,
    marketplaceContract: MARKETPLACE_721_CONTRACT,
  });
}

function parseOrderDetails721(raw: any): OnChainOrderDetails {
  // starknet.js v6 CairoCustomEnum — use activeVariant() to get the live variant name
  const statusVariant: string =
    typeof raw.order_status?.activeVariant === "function"
      ? raw.order_status.activeVariant()
      : "";
  let status: "active" | "fulfilled" | "cancelled" = "active";
  if (statusVariant === "Filled") status = "fulfilled";
  if (statusVariant === "Cancelled") status = "cancelled";

  // starknet.js v6 CairoOption — .Some is undefined (not absent) for None variants
  const fulfillerOption = raw.fulfiller;
  let fulfiller: string | null = null;
  const fulfillerSome: unknown =
    typeof fulfillerOption?.isSome === "function"
      ? fulfillerOption.isSome()
        ? fulfillerOption.unwrap()
        : undefined
      : fulfillerOption?.Some;
  if (fulfillerSome !== undefined && fulfillerSome !== null) {
    fulfiller = normalizeAddress(String(fulfillerSome));
  }

  return {
    offerer: normalizeAddress(raw.offerer.toString()),
    offerItemType: decodeShortstring(raw.offer.item_type),
    offerToken: normalizeAddress(raw.offer.token.toString()),
    offerIdentifier: raw.offer.identifier_or_criteria.toString(),
    offerStartAmount: raw.offer.start_amount.toString(),
    offerEndAmount: raw.offer.end_amount.toString(),
    considerationItemType: decodeShortstring(raw.consideration.item_type),
    considerationToken: normalizeAddress(raw.consideration.token.toString()),
    considerationIdentifier: raw.consideration.identifier_or_criteria.toString(),
    considerationStartAmount: raw.consideration.start_amount.toString(),
    considerationEndAmount: raw.consideration.end_amount.toString(),
    considerationRecipient: normalizeAddress(raw.consideration.recipient.toString()),
    startTime: BigInt(raw.start_time.toString()),
    endTime: BigInt(raw.end_time.toString()),
    status,
    fulfiller,
  };
}

// ── ERC-1155 entry ─────────────────────────────────────────────────────────────

const GET_ORDER_DETAILS_SELECTOR = hash.getSelectorFromName("get_order_details");
const LAVA_RPC_URL = "https://rpc.starknet.lava.build/";

export async function handleOrderCreated1155(
  event: RawStarknetEvent,
  tx: Prisma.TransactionClient,
  chain: Chain,
): Promise<string | null> {
  const orderHash = num.toHex(event.keys[1]);

  let details: OnChainOrderDetails;
  try {
    details = await withRetry(() => fetchOrderDetails1155(orderHash), 3, 500);
  } catch (err) {
    log.error(
      { err, orderHash },
      "Failed to fetch ERC-1155 order details from RPC after retries — order will be missing",
    );
    return null;
  }

  const blockNumber = typeof event.block_number === "number"
    ? BigInt(event.block_number)
    : BigInt(event.block_number ?? 0);
  const txHash = event.transaction_hash ?? "";

  return applyOrderCreated(tx, chain, {
    orderHash,
    details,
    blockNumber,
    txHash,
    marketplaceContract: MARKETPLACE_1155_CONTRACT,
  });
}

async function fetchOrderDetails1155(orderHash: string): Promise<OnChainOrderDetails> {
  const urls = Array.from(new Set([
    env.ALCHEMY_RPC_URL,
    env.STARKNET_RPC_FALLBACK_URL,
    LAVA_RPC_URL,
  ].filter((url): url is string => Boolean(url))));
  let lastError: unknown;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "starknet_call",
          params: {
            request: {
              contract_address: MARKETPLACE_1155_CONTRACT,
              entry_point_selector: GET_ORDER_DETAILS_SELECTOR,
              calldata: [orderHash],
            },
            block_id: "latest",
          },
          id: 1,
        }),
      });

      const json = await res.json() as { result?: string[]; error?: unknown };
      if (json.result && json.result.length >= 17) {
        return decodeOrderDetails1155(json.result);
      }
      lastError = json.error ?? new Error(`Empty / short RPC response from ${url}`);
      log.warn({ orderHash, rpcError: json.error }, "ERC-1155 get_order_details RPC error — trying next endpoint");
    } catch (err) {
      lastError = err;
      log.warn({ err, orderHash }, "ERC-1155 get_order_details RPC failed — trying next endpoint");
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`get_order_details failed: ${JSON.stringify(lastError)}`);
}

function decodeOrderDetails1155(raw: string[]): OnChainOrderDetails {
  return {
    offerer: normalizeAddress(raw[0]),
    offerItemType: decodeShortstring(raw[1]),
    offerToken: normalizeAddress(raw[2]),
    offerIdentifier: BigInt(raw[3]).toString(),
    offerStartAmount: BigInt(raw[4]).toString(),
    offerEndAmount: BigInt(raw[5]).toString(),
    considerationItemType: decodeShortstring(raw[6]),
    considerationToken: normalizeAddress(raw[7]),
    considerationIdentifier: BigInt(raw[8]).toString(),
    considerationStartAmount: BigInt(raw[9]).toString(),
    considerationEndAmount: BigInt(raw[10]).toString(),
    considerationRecipient: normalizeAddress(raw[11]),
    startTime: BigInt(raw[12]),
    endTime: BigInt(raw[13]),
    remainingAmount: BigInt(raw[16]).toString(),
    // Status + fulfiller are not exposed by the 1155 marketplace's
    // get_order_details — default to active/null; fulfillment events
    // update these fields when they arrive.
    status: "active",
    fulfiller: null,
  };
}
