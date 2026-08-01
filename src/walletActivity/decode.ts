import type { RawStarknetEvent } from "../types/starknet.js";
import {
  TRANSFER_SELECTOR, ACCOUNT_CREATED_GUID_SELECTOR, GUARDIAN_ADDED_GUID_SELECTOR,
  ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR, OWNER_ESCAPED_GUID_SELECTOR, ESCAPE_CANCELED_SELECTOR,
} from "../config/constants.js";

export interface TransferLeg {
  tokenAddress: string;
  from: string;
  to: string;
  amount: string;
  txHash: string;
  blockNumber: bigint;
}

/** Standard ERC-20 Transfer: keys = [selector, from, to], data = [value_low, value_high]. */
export function decodeTransferLeg(event: RawStarknetEvent, tokenAddress: string): TransferLeg | null {
  if (event.keys[0] !== TRANSFER_SELECTOR) return null;
  const [from, to] = [event.keys[1], event.keys[2]];
  const [low, high] = [BigInt(event.data[0] ?? "0x0"), BigInt(event.data[1] ?? "0x0")];
  const amount = (low + (high << 128n)).toString();
  return { tokenAddress, from, to, amount, txHash: event.transaction_hash, blockNumber: BigInt(event.block_number) };
}

const ACCOUNT_EVENT_TYPES: Record<string, "DEPLOY" | "GUARDIAN_SET" | "GUARDIAN_TRIGGER_ESCAPE" | "GUARDIAN_COMPLETE_ESCAPE" | "GUARDIAN_CANCEL_ESCAPE"> = {
  [ACCOUNT_CREATED_GUID_SELECTOR]: "DEPLOY",
  [GUARDIAN_ADDED_GUID_SELECTOR]: "GUARDIAN_SET",
  [ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR]: "GUARDIAN_TRIGGER_ESCAPE",
  [OWNER_ESCAPED_GUID_SELECTOR]: "GUARDIAN_COMPLETE_ESCAPE",
  [ESCAPE_CANCELED_SELECTOR]: "GUARDIAN_CANCEL_ESCAPE",
};

/**
 * Recognizes the account-contract events wallet-native activity cares about.
 * EscapeCanceled carries no distinguishing data (`pub struct EscapeCanceled {}`)
 * — an owner-escape cancel and a guardian-escape cancel are indistinguishable
 * from the event alone. Both map to GUARDIAN_CANCEL_ESCAPE; this is a known,
 * accepted limitation, not a bug to chase — self-guardian v1 practically only
 * ever exercises the owner-escape path.
 */
export function decodeAccountEvent(event: RawStarknetEvent): { type: "DEPLOY" | "GUARDIAN_SET" | "GUARDIAN_TRIGGER_ESCAPE" | "GUARDIAN_COMPLETE_ESCAPE" | "GUARDIAN_CANCEL_ESCAPE" } | null {
  const type = ACCOUNT_EVENT_TYPES[event.keys[0]];
  return type ? { type } : null;
}

export interface SwapPair {
  txHash: string;
  blockNumber: bigint;
  tokenInAddress: string;
  amountIn: string;
  tokenOutAddress: string;
  amountOut: string;
}

/**
 * Groups transfer legs by txHash; a tx with exactly one leg OUT of the account
 * and one leg IN to the account, on two different tokens, is a swap. Anything
 * else (a lone leg, same-token legs, more than two legs) stays as individual
 * transfer legs — safer to under-merge than to guess wrong on an unusual tx.
 */
export function pairSwapLegs(legs: TransferLeg[], accountAddress: string): { swaps: SwapPair[]; remaining: TransferLeg[] } {
  const byTx = new Map<string, TransferLeg[]>();
  for (const leg of legs) {
    const group = byTx.get(leg.txHash) ?? [];
    group.push(leg);
    byTx.set(leg.txHash, group);
  }

  const swaps: SwapPair[] = [];
  const remaining: TransferLeg[] = [];
  for (const group of byTx.values()) {
    const outLeg = group.find((l) => l.from === accountAddress);
    const inLeg = group.find((l) => l.to === accountAddress);
    const isSwap = group.length === 2 && outLeg && inLeg && outLeg.tokenAddress !== inLeg.tokenAddress;
    if (isSwap) {
      swaps.push({
        txHash: outLeg.txHash, blockNumber: outLeg.blockNumber,
        tokenInAddress: outLeg.tokenAddress, amountIn: outLeg.amount,
        tokenOutAddress: inLeg.tokenAddress, amountOut: inLeg.amount,
      });
    } else {
      remaining.push(...group);
    }
  }
  return { swaps, remaining };
}
