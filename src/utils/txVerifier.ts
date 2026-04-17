import { env } from "../config/env.js";
import { normalizeAddress } from "./starknet.js";
import { MARKETPLACE_CONTRACT, MARKETPLACE_1155_CONTRACT } from "../config/constants.js";
import { createLogger } from "./logger.js";

const log = createLogger("txVerifier");

// Retry delays for receipt fetching: 0s, 3s, 5s, 7s, 10s.
// Backend uses a private Alchemy node — no load-balancer randomness.
// A short sequence is sufficient; the frontend handles user-facing timeout.
const RETRY_DELAYS_MS = [0, 3000, 5000, 7000, 10_000];

export type VerifyResult =
  | { status: "CONFIRMED" }
  | { status: "FAILED"; failReason: string };

/**
 * Verify that a Starknet transaction emitted at least one event from a
 * marketplace contract. Accepts an optional extra contract address so that
 * ERC-1155 marketplace operations (MARKETPLACE_1155_CONTRACT) are verified
 * correctly in addition to the default ERC-721 marketplace.
 *
 * Catches ChipiPay silent failures where the outer multicall reports SUCCEEDED
 * but the inner marketplace call panics.
 */
export async function verifyMarketplaceTx(
  txHash: string,
  extraContractAddress?: string
): Promise<VerifyResult> {
  const validContracts = new Set([
    normalizeAddress(MARKETPLACE_CONTRACT),
    normalizeAddress(MARKETPLACE_1155_CONTRACT),
    ...(extraContractAddress ? [normalizeAddress(extraContractAddress)] : []),
  ]);

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
          (e) => validContracts.has(normalizeAddress(e.from_address ?? ""))
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
