import { hash } from "starknet";
import { postRpc } from "./rpcFetch.js";
import { normalizeAddress, normalizeHash } from "./starknet.js";
import { MARKETPLACE_721_CONTRACT, MARKETPLACE_1155_CONTRACT } from "../config/constants.js";
import { createLogger } from "./logger.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const log = createLogger("txVerifier");

// Retry delays for receipt fetching: 0s, 3s, 5s, 7s, 10s.
// Backend uses a private Alchemy node — no load-balancer randomness.
// A short sequence is sufficient; the frontend handles user-facing timeout.
const RETRY_DELAYS_MS = [0, 3000, 5000, 7000, 10_000];

// Built once at module load — both marketplace contracts are static constants.
// An event from either address counts as a confirmed marketplace operation.
const VALID_MARKETPLACE_CONTRACTS = new Set([
  normalizeAddress("STARKNET", MARKETPLACE_721_CONTRACT),
  normalizeAddress("STARKNET", MARKETPLACE_1155_CONTRACT),
]);

export type VerifyResult =
  | { status: "CONFIRMED" }
  | { status: "FAILED"; failReason: string };

export type MarketplaceReceiptEvent = {
  from_address: string;
  keys: string[];
  data: string[];
  block_number: number;
  transaction_hash: string;
  block_hash: string;
};

/**
 * Verify that a Starknet transaction emitted at least one event from a
 * marketplace contract (ERC-721 or ERC-1155). Catches ChipiPay silent
 * failures where the outer multicall reports SUCCEEDED but the inner
 * marketplace call panics.
 */
export async function verifyMarketplaceTx(txHash: string): Promise<VerifyResult> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }

    try {
      const json = await fetchReceipt(txHash);
      const receipt = json?.result;

      if (!receipt) {
        log.debug({ txHash, attempt }, "No receipt yet, retrying");
        continue;
      }

      const execStatus = (receipt.execution_status ?? receipt.status) as string | undefined;

      if (execStatus === "REVERTED" || execStatus === "REJECTED") {
        const reason = (receipt.revert_reason as string | undefined) ??
          `Transaction reverted (${execStatus})`;
        log.warn({ txHash, execStatus, reason }, "Tx reverted");
        return { status: "FAILED", failReason: reason };
      }

      if (execStatus !== "SUCCEEDED") {
        // Still pending — retry
        log.debug({ txHash, execStatus, attempt }, "Tx not yet finalized, retrying");
        continue;
      }

      const events = (receipt.events as Array<{ from_address?: string }>) ?? [];

      // Events present — check for marketplace event (ERC-721 or ERC-1155 contract)
      if (events.length > 0) {
        const hasMarketplaceEvent = events.some(
          (e) => VALID_MARKETPLACE_CONTRACTS.has(safeNormalizeAddress(e.from_address))
        );

        if (hasMarketplaceEvent) {
          log.info({ txHash }, "Tx verified: marketplace event confirmed");
          return { status: "CONFIRMED" };
        }

        // Events present but none from marketplace — silent inner-call failure
        log.warn({
          txHash,
          eventCount: events.length,
          eventContracts: Array.from(new Set(events.map((e) => safeNormalizeAddress(e.from_address)))),
          marketplaceContracts: Array.from(VALID_MARKETPLACE_CONTRACTS),
        }, "Tx accepted but no marketplace event — inner call panicked");
        return {
          status: "FAILED",
          failReason:
            "Transaction was submitted but the marketplace operation did not complete onchain. " +
            "Please check your token balance and try again.",
        };
      }

      // Empty events array — might be RPC indexing lag, retry
      log.debug({ txHash, attempt }, "Empty events, retrying");
    } catch (err) {
      log.warn({ err, txHash, attempt }, "Receipt fetch failed, retrying");
    }
  }

  log.warn({ txHash }, "Tx verification timed out after all retries");
  return {
    status: "FAILED",
    failReason:
      "Transaction verification timed out. Check your wallet for the transaction status.",
  };
}

export async function verifyTransactionSucceeded(txHash: string): Promise<VerifyResult> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }

    try {
      const json = await fetchReceipt(txHash);
      const receipt = json?.result;

      if (!receipt) {
        log.debug({ txHash, attempt }, "No receipt yet, retrying");
        continue;
      }

      const execStatus = (receipt.execution_status ?? receipt.status) as string | undefined;

      if (execStatus === "REVERTED" || execStatus === "REJECTED") {
        const reason = (receipt.revert_reason as string | undefined) ??
          `Transaction reverted (${execStatus})`;
        log.warn({ txHash, execStatus, reason }, "Tx reverted");
        return { status: "FAILED", failReason: reason };
      }

      if (execStatus === "SUCCEEDED") {
        return { status: "CONFIRMED" };
      }

      log.debug({ txHash, execStatus, attempt }, "Tx not yet finalized, retrying");
    } catch (err) {
      log.warn({ err, txHash, attempt }, "Receipt fetch failed, retrying");
    }
  }

  return {
    status: "FAILED",
    failReason: "Transaction verification timed out. Check your wallet for the transaction status.",
  };
}

export async function fetchMarketplaceReceiptEvents(txHash: string): Promise<MarketplaceReceiptEvent[]> {
  const json = await fetchReceipt(txHash);
  const receipt = json.result;
  if (!receipt) return [];

  const normalizedTxHash = normalizeHash(txHash);
  const blockNumber = Number(receipt.block_number ?? 0);
  const blockHash = typeof receipt.block_hash === "string" ? receipt.block_hash : "";
  const events = (receipt.events as Array<{ from_address?: string; keys?: string[]; data?: string[] }>) ?? [];

  return events
    .filter((event) => VALID_MARKETPLACE_CONTRACTS.has(safeNormalizeAddress(event.from_address)))
    .map((event) => ({
      from_address: safeNormalizeAddress(event.from_address),
      keys: event.keys ?? [],
      data: event.data ?? [],
      block_number: blockNumber,
      transaction_hash: normalizedTxHash,
      block_hash: blockHash,
    }));
}

export async function fetchReceiptEvents(txHash: string): Promise<RawStarknetEvent[]> {
  const json = await fetchReceipt(txHash);
  const receipt = json.result;
  if (!receipt) return [];

  const normalizedTxHash = normalizeHash(txHash);
  const blockNumber = Number(receipt.block_number ?? 0);
  const blockHash = typeof receipt.block_hash === "string" ? receipt.block_hash : "";
  const events = (receipt.events as Array<{ from_address?: string; keys?: string[]; data?: string[] }>) ?? [];

  return events.map((event) => ({
    from_address: safeNormalizeAddress(event.from_address),
    keys: event.keys ?? [],
    data: event.data ?? [],
    block_number: blockNumber,
    transaction_hash: normalizedTxHash,
    block_hash: blockHash,
  }));
}

async function fetchReceipt(txHash: string): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  return postRpc<Record<string, unknown>>(
    {
      jsonrpc: "2.0",
      method: "starknet_getTransactionReceipt",
      params: { transaction_hash: txHash },
      id: 1,
    },
    { txHash },
  );
}

function safeNormalizeAddress(address?: string): string {
  if (!address) return "";
  try {
    return normalizeAddress("STARKNET", address);
  } catch {
    return address;
  }
}

// OrderDetails flat layout: [offerer, offer×5, consideration×6, start_time, end_time, order_status, ...]
const ORDER_STATUS_INDEX = { erc721: 14, erc1155: 14 };
const GET_ORDER_DETAILS_SELECTOR = hash.getSelectorFromName("get_order_details");

/**
 * Call get_order_details on-chain and return true if the order's status is Cancelled.
 * Used to detect orders that are already cancelled on-chain but still ACTIVE in the DB.
 * Returns false on any error (safe fallback — don't make incorrect updates).
 */
export async function checkOnChainOrderCancelled(orderHash: string, is1155: boolean): Promise<boolean> {
  const contractAddress = is1155 ? MARKETPLACE_1155_CONTRACT : MARKETPLACE_721_CONTRACT;
  const statusIndex = is1155 ? ORDER_STATUS_INDEX.erc1155 : ORDER_STATUS_INDEX.erc721;

  try {
    const { result } = await postRpc<string[]>(
      {
        jsonrpc: "2.0",
        method: "starknet_call",
        params: {
          request: {
            contract_address: contractAddress,
            entry_point_selector: GET_ORDER_DETAILS_SELECTOR,
            calldata: [orderHash],
          },
          block_id: "latest",
        },
        id: 1,
      },
      { orderHash },
    );
    if (!result || result.length <= statusIndex) return false;

    // Cairo OrderStatus enum: 0=None, 1=Created, 2=Filled, 3=Cancelled
    return Number(BigInt(result[statusIndex])) === 3; // Cancelled
  } catch (err) {
    log.warn({ err, orderHash }, "checkOnChainOrderCancelled: RPC call failed");
    return false;
  }
}
