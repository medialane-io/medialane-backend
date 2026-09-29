import { createLogger } from "../utils/logger.js";
import { normalizeAddress, normalizeHash } from "../utils/starknet.js";
import { tokenByAddress } from "../payments/token-value.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const log = createLogger("funding:deposits");

export const TRANSFER_SELECTOR = BigInt("0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9");

export interface DepositEvent {
  txHash: string;
  token: string;
  amountAtomic: bigint;
  payer: string;
  blockNumber: number;
  depositIndex: number;
}

export function depositNonce(txHash: string, depositIndex: number): string {
  return depositIndex === 0 ? txHash : `${txHash}:${depositIndex}`;
}

function isTransfer(ev: RawStarknetEvent): boolean {
  try {
    return BigInt(ev.keys?.[0] ?? "0x0") === TRANSFER_SELECTOR;
  } catch {
    return false;
  }
}

export function parseDepositEvents(events: RawStarknetEvent[], treasury: string): DepositEvent[] {
  const to = normalizeAddress("STARKNET", treasury);
  const out: DepositEvent[] = [];
  const perTransaction = new Map<string, number>();

  for (const ev of events) {
    try {
      if (!isTransfer(ev)) continue;
      const token = tokenByAddress(ev.from_address);
      if (!token) continue;
      if (!ev.keys?.[2] || normalizeAddress("STARKNET", ev.keys[2]) !== to) continue;
      if (!ev.keys[1] || !ev.data?.[0]) continue;

      const low = BigInt(ev.data[0]);
      const high = ev.data[1] ? BigInt(ev.data[1]) : 0n;
      const amountAtomic = low + (high << 128n);
      if (amountAtomic === 0n) continue;

      const txHash = normalizeHash(ev.transaction_hash);
      const depositIndex = perTransaction.get(txHash) ?? 0;
      perTransaction.set(txHash, depositIndex + 1);

      out.push({
        txHash,
        token: normalizeAddress("STARKNET", token.address),
        amountAtomic,
        payer: normalizeAddress("STARKNET", ev.keys[1]),
        blockNumber: Number(ev.block_number ?? 0),
        depositIndex,
      });
    } catch {
      log.warn({ txHash: ev.transaction_hash }, "Skipped an unreadable event while scanning deposits");
    }
  }

  return out;
}
