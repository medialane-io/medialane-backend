import { getCoordinates, getListableTokens } from "@medialane/sdk";
import prisma from "../../db/client.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { verifyAndSettle } from "./intents/settle.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:sponsor-intents");

export type IntentCall = { contractAddress: string; entrypoint: string; calldata: string[] };

export interface SponsorIntentRow {
  id: string;
  type: string;
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
  known(addresses: string[], wallet: string): Promise<Set<string>>;
  now(): Date;
}

class ClaimTaken extends Error {}

export async function composeIntentCalls(
  intentIds: string[],
  caller: { accountId: string; wallet: string },
  deps: SponsorIntentDeps,
): Promise<{ ok: true; calls: IntentCall[] } | { ok: false; unavailable?: true; error: string }> {
  if (intentIds.length === 0 || new Set(intentIds).size !== intentIds.length) {
    return { ok: false, error: "A list of distinct intent ids is required" };
  }
  const rows = new Map((await deps.load(intentIds)).map((r) => [r.id, r]));
  const wallet = normalizeAddress("STARKNET", caller.wallet);
  const now = deps.now();
  const calls: IntentCall[] = [];
  const targets = new Set<string>();
  for (const id of intentIds) {
    const row = rows.get(id);
    if (!row || row.accountId !== caller.accountId) return { ok: false, error: "Intent not found" };
    if (normalizeAddress("STARKNET", row.requester) !== wallet) return { ok: false, error: "This intent belongs to another wallet" };
    if (row.status !== "SIGNED" || row.expiresAt < now) return { ok: false, error: "This intent can no longer be sponsored" };
    for (const call of row.calls as IntentCall[]) {
      calls.push(call);
      if (row.type === "SWAP" && call.entrypoint !== "approve") continue;
      targets.add(normalizeAddress("STARKNET", call.contractAddress));
    }
  }
  const known = await deps.known([...targets], wallet);
  if ([...targets].some((t) => !known.has(t))) return { ok: false, unavailable: true, error: "These actions can't be sponsored" };
  return { ok: true, calls };
}

export const prismaSponsorIntentDeps: SponsorIntentDeps = {
  load: (ids) =>
    prisma.transactionIntent.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true, accountId: true, requester: true, status: true, expiresAt: true, calls: true },
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
  known: (addresses, wallet) => knownTargets(addresses, wallet),
  now: () => new Date(),
};

export interface KnownTargetDeps {
  protocolAddresses(): string[];
  protocolClassHashes(): string[];
  indexed(addresses: string[]): Promise<string[]>;
  classHashOf(address: string): Promise<string | null>;
}

export function createKnownTargets(deps: KnownTargetDeps) {
  return async (addresses: string[], wallet: string): Promise<Set<string>> => {
    const norm = (a: string) => normalizeAddress("STARKNET", a);
    const fixed = new Set([...deps.protocolAddresses(), wallet].map(norm));
    const known = new Set(addresses.filter((a) => fixed.has(norm(a))).map(norm));
    let rest = addresses.map(norm).filter((a) => !known.has(a));
    if (rest.length === 0) return known;
    for (const a of await deps.indexed(rest)) known.add(norm(a));
    rest = rest.filter((a) => !known.has(a));
    if (rest.length === 0) return known;
    const classes = new Set(deps.protocolClassHashes().map((h) => BigInt(h)));
    const hashes = await Promise.all(rest.map((a) => deps.classHashOf(a)));
    rest.forEach((a, i) => {
      const hash = hashes[i];
      if (hash && classes.has(BigInt(hash))) known.add(a);
    });
    return known;
  };
}

function coordinateValues(match: (key: string) => boolean): string[] {
  const coordinates = getCoordinates("STARKNET") as unknown as Record<string, unknown>;
  return Object.entries(coordinates)
    .filter(([key, value]) => typeof value === "string" && value.startsWith("0x") && match(key))
    .map(([, value]) => value as string);
}

const knownTargets = createKnownTargets({
  protocolAddresses: () => [...coordinateValues((key) => !key.endsWith("ClassHash")), ...getListableTokens().map((t) => t.address)],
  protocolClassHashes: () => coordinateValues((key) => key.endsWith("ClassHash") && key !== "mediaWalletClassHash"),
  indexed: async (addresses) => {
    const [collections, coins] = await Promise.all([
      prisma.collection.findMany({ where: { chain: "STARKNET", contractAddress: { in: addresses } }, select: { contractAddress: true } }),
      prisma.coin.findMany({ where: { chain: "STARKNET", contractAddress: { in: addresses } }, select: { contractAddress: true } }),
    ]);
    return [...collections, ...coins].map((row) => row.contractAddress);
  },
  classHashOf: (address) =>
    callRpc((provider) => provider.getClassHashAt(address)).then(String).catch(() => null),
});
