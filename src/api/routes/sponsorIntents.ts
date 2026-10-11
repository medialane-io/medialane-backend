import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { verifyAndSettle } from "./intents/settle.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:sponsor-intents");

export type IntentCall = { contractAddress: string; entrypoint: string; calldata: string[] };

export interface SponsorIntentRow {
  id: string;
  accountId: string | null;
  requester: string;
  status: string;
  expiresAt: Date;
  calls: unknown;
}

export interface SponsorIntentDeps {
  load(ids: string[]): Promise<SponsorIntentRow[]>;
  claim(ids: string[]): Promise<boolean>;
  release(ids: string[]): Promise<void>;
  record(ids: string[], txHash: string): Promise<void>;
  now(): Date;
}

export const MAX_SPONSORED_INTENTS = 20;

class ClaimTaken extends Error {}

export async function composeIntentCalls(
  intentIds: string[],
  caller: { accountId: string; wallet: string },
  deps: SponsorIntentDeps,
): Promise<{ ok: true; calls: IntentCall[] } | { ok: false; error: string }> {
  if (intentIds.length === 0 || intentIds.length > MAX_SPONSORED_INTENTS || new Set(intentIds).size !== intentIds.length) {
    return { ok: false, error: "A list of distinct intent ids is required" };
  }
  const rows = new Map((await deps.load(intentIds)).map((r) => [r.id, r]));
  const wallet = normalizeAddress("STARKNET", caller.wallet);
  const now = deps.now();
  const calls: IntentCall[] = [];
  for (const id of intentIds) {
    const row = rows.get(id);
    if (!row || row.accountId !== caller.accountId) return { ok: false, error: "Intent not found" };
    if (normalizeAddress("STARKNET", row.requester) !== wallet) return { ok: false, error: "This intent belongs to another wallet" };
    if (row.status !== "SIGNED" || row.expiresAt < now) return { ok: false, error: "This intent can no longer be sponsored" };
    calls.push(...(row.calls as IntentCall[]));
  }
  return { ok: true, calls };
}

export const prismaSponsorIntentDeps: SponsorIntentDeps = {
  load: (ids) =>
    prisma.transactionIntent.findMany({
      where: { id: { in: ids } },
      select: { id: true, accountId: true, requester: true, status: true, expiresAt: true, calls: true },
    }),
  claim: async (ids) => {
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.transactionIntent.updateMany({
          where: { id: { in: ids }, status: "SIGNED" },
          data: { status: "SUBMITTED" },
        });
        if (count !== ids.length) throw new ClaimTaken();
      });
      return true;
    } catch (err) {
      if (err instanceof ClaimTaken) return false;
      throw err;
    }
  },
  release: async (ids) => {
    await prisma.transactionIntent.updateMany({ where: { id: { in: ids }, status: "SUBMITTED", txHash: null }, data: { status: "SIGNED" } });
  },
  record: async (ids, txHash) => {
    await prisma.transactionIntent.updateMany({ where: { id: { in: ids } }, data: { txHash } });
    for (const id of ids) {
      verifyAndSettle(id, txHash).catch((err) => log.error({ err, id, txHash }, "verifyAndSettle failed after sponsorship"));
    }
  },
  now: () => new Date(),
};
