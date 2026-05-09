/**
 * Handle OrderCreated events from the audited Medialane1155 marketplace.
 *
 * The deployed V2 contract emits only order_hash + offerer in OrderCreated,
 * so canonical order details must be fetched from get_order_details().
 */
import { hash, num } from "starknet";
import type { Chain, Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import { MARKETPLACE_1155_CONTRACT } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import { withRetry } from "../../utils/retry.js";

const log = createLogger("handler:orderCreated1155");
const GET_ORDER_DETAILS_SELECTOR = hash.getSelectorFromName("get_order_details");
const LAVA_RPC_URL = "https://rpc.starknet.lava.build/";

type OrderDetails1155 = {
  offerer: string;
  offerItemType: string;
  offerToken: string;
  offerIdentifier: string;
  offerStartAmount: string;
  offerEndAmount: string;
  considerationItemType: string;
  considerationToken: string;
  considerationIdentifier: string;
  considerationStartAmount: string;
  considerationEndAmount: string;
  considerationRecipient: string;
  startTime: bigint;
  endTime: bigint;
  remainingAmount: string;
};

export async function handleOrderCreated1155(
  event: RawStarknetEvent,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<string | null> {
  const orderHash = num.toHex(event.keys[1]);

  let details: OrderDetails1155;
  try {
    details = await withRetry(() => fetchOrderDetails1155(orderHash), 3, 500);
  } catch (err) {
    log.error(
      { err, orderHash },
      "Failed to fetch ERC-1155 order details from RPC after retries — order will be missing"
    );
    return null;
  }

  const isListing = details.offerItemType === "ERC1155";
  const isBid = details.considerationItemType === "ERC1155";
  const priceTokenAddress = isBid ? details.offerToken : details.considerationToken;
  const priceRaw = isBid ? details.offerStartAmount : details.considerationStartAmount;
  const paymentTokenMeta = getTokenByAddress(priceTokenAddress);
  const priceFormatted = paymentTokenMeta
    ? formatAmount(priceRaw, paymentTokenMeta.decimals)
    : priceRaw;
  const currencySymbol = paymentTokenMeta?.symbol ?? null;
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

  const blockNumber = typeof event.block_number === "number"
    ? event.block_number
    : Number(event.block_number ?? 0);
  const txHash = event.transaction_hash ?? "";

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
      createdBlockNumber: BigInt(blockNumber),
      createdTxHash: txHash,
      nftContract,
      nftTokenId,
      priceRaw,
      priceFormatted,
      currencySymbol,
      marketplaceContract: normalizeAddress(MARKETPLACE_1155_CONTRACT),
      remainingAmount: details.remainingAmount,
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
      marketplaceContract: normalizeAddress(MARKETPLACE_1155_CONTRACT),
      remainingAmount: details.remainingAmount,
    },
  });

  if (nftContract && nftTokenId) {
    await tx.collection.upsert({
      where: { chain_contractAddress: { chain, contractAddress: nftContract } },
      create: {
        chain,
        contractAddress: nftContract,
        startBlock: blockNumber,
        standard: "ERC1155",
        source: "ERC1155_FACTORY",
      },
      update: {
        standard: "ERC1155",
        source: "ERC1155_FACTORY",
      },
    });

    await tx.token.upsert({
      where: { chain_contractAddress_tokenId: { chain, contractAddress: nftContract, tokenId: nftTokenId } },
      create: { chain, contractAddress: nftContract, tokenId: nftTokenId, metadataStatus: "PENDING" },
      update: {},
    });
  }

  log.debug({ chain, orderHash, nftContract, nftTokenId, remainingAmount: details.remainingAmount }, "ERC-1155 order created");
  return nftContract;
}

async function fetchOrderDetails1155(orderHash: string): Promise<OrderDetails1155> {
  const json = await callGetOrderDetails1155(orderHash);
  if (!json.result || json.result.length < 17) {
    throw new Error(`Invalid get_order_details response: ${JSON.stringify(json.error ?? json.result)}`);
  }

  const raw = json.result;
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
  };
}

async function callGetOrderDetails1155(orderHash: string): Promise<{ result?: string[]; error?: unknown }> {
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
      if (json.result) return json;
      lastError = json.error ?? new Error(`Empty RPC response from ${url}`);
      log.warn({ orderHash, rpcError: json.error }, "ERC-1155 get_order_details RPC returned an error, trying next endpoint");
    } catch (err) {
      lastError = err;
      log.warn({ err, orderHash }, "ERC-1155 get_order_details RPC failed, trying next endpoint");
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`get_order_details failed: ${JSON.stringify(lastError)}`);
}

/** Decode a Cairo felt252 short string into its ASCII representation. */
function decodeShortstring(felt: unknown): string {
  try {
    let n = BigInt(String(felt));
    const bytes: number[] = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    }
    return Buffer.from(bytes).toString("ascii");
  } catch {
    return String(felt);
  }
}
