import { hash } from "starknet";
import { env } from "../config/env.js";
import { normalizeAddress } from "./starknet.js";
import { MARKETPLACE_CONTRACT, MARKETPLACE_1155_CONTRACT } from "../config/constants.js";
import { createLogger } from "./logger.js";

const log = createLogger("txVerifier");

// Retry delays for receipt fetching: 0s, 3s, 5s, 7s, 10s.
// Backend uses a private Alchemy node — no load-balancer randomness.
// A short sequence is sufficient; the frontend handles user-facing timeout.
const RETRY_DELAYS_MS = [0, 3000, 5000, 7000, 10_000];

// Built once at module load — both marketplace contracts are static constants.
// An event from either address counts as a confirmed marketplace operation.
const VALID_MARKETPLACE_CONTRACTS = new Set([
  normalizeAddress(MARKETPLACE_CONTRACT),
  normalizeAddress(MARKETPLACE_1155_CONTRACT),
]);

export type VerifyResult =
  | { status: "CONFIRMED" }
  | { status: "FAILED"; failReason: string };

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
      const res = await fetch(env.ALCHEMY_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "starknet_getTransactionReceipt",
          params: { transaction_hash: txHash },
          id: 1,
        }),
      });

      const json = await res.json() as { result?: Record<string, unknown> };
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
          (e) => VALID_MARKETPLACE_CONTRACTS.has(normalizeAddress(e.from_address ?? ""))
        );

        if (hasMarketplaceEvent) {
          log.info({ txHash }, "Tx verified: marketplace event confirmed");
          return { status: "CONFIRMED" };
        }

        // Events present but none from marketplace — silent inner-call failure
        log.warn({ txHash, eventCount: events.length }, "Tx accepted but no marketplace event — inner call panicked");
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

// ERC-721 OrderDetails flat layout: [offerer, offer×5, consideration×6, start_time, end_time, order_status, ...]
// ERC-1155 OrderDetails flat layout: [offerer, nft_contract, token_id, amount, payment_token, price_per_unit, start_time, end_time, order_status, ...]
const ORDER_STATUS_INDEX = { erc721: 14, erc1155: 8 };
const GET_ORDER_DETAILS_SELECTOR = hash.getSelectorFromName("get_order_details");

/**
 * Call get_order_details on-chain and return true if the order's status is Cancelled.
 * Used to detect orders that are already cancelled on-chain but still ACTIVE in the DB.
 * Returns false on any error (safe fallback — don't make incorrect updates).
 */
export async function checkOnChainOrderCancelled(orderHash: string, is1155: boolean): Promise<boolean> {
  const contractAddress = is1155 ? MARKETPLACE_1155_CONTRACT : MARKETPLACE_CONTRACT;
  const statusIndex = is1155 ? ORDER_STATUS_INDEX.erc1155 : ORDER_STATUS_INDEX.erc721;

  try {
    const res = await fetch(env.ALCHEMY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    });

    const json = await res.json() as { result?: string[]; error?: unknown };
    if (!json.result || json.result.length <= statusIndex) return false;

    // Cairo OrderStatus enum: 0=None, 1=Created, 2=Filled, 3=Cancelled
    const statusVal = Number(BigInt(json.result[statusIndex]));
    return statusVal === 3; // Cancelled
  } catch (err) {
    log.warn({ err, orderHash }, "checkOnChainOrderCancelled: RPC call failed");
    return false;
  }
}
