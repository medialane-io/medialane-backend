import prisma from "../db/client.js";
import { readOwnership, type OwnershipFact, type OwnershipKey } from "../chainRead/ownership.js";
import { writeOwnership } from "../mirror/handlers/ownership.js";

type StoredRow = { contractAddress: string; tokenId: string; owner: string; amount: string };
type Differences = { changed: number; removed: number; added: number };

const CHAIN = "STARKNET" as const;
const BATCH = 200;
const PROGRESS_EVERY = 1000;

/** How the stored rows for the facts' tokens differ from what the chain reports. */
export function ownershipDifferences(rows: StoredRow[], facts: OwnershipFact[]): Differences {
  const diff: Differences = { changed: 0, removed: 0, added: 0 };
  const byToken = new Map<string, StoredRow[]>();
  for (const row of rows) {
    const key = `${row.contractAddress}:${row.tokenId}`;
    byToken.set(key, [...(byToken.get(key) ?? []), row]);
  }

  for (const fact of facts) {
    const stored = byToken.get(`${fact.contractAddress}:${fact.tokenId}`) ?? [];
    if (fact.standard === "ERC721") {
      if (fact.owner === null) diff.removed += stored.length;
      else if (stored.length === 0) diff.added++;
      else if (stored.length !== 1 || stored[0]!.owner !== fact.owner || stored[0]!.amount !== "1") diff.changed++;
      continue;
    }
    const row = stored.find((r) => r.owner === fact.owner);
    if (!row) {
      if (fact.amount > 0n) diff.added++;
    } else if (fact.amount === 0n) {
      diff.removed++;
    } else if (BigInt(row.amount) !== fact.amount) {
      diff.changed++;
    }
  }
  return diff;
}

async function keysFor(contractAddress: string, standard: "ERC721" | "ERC1155"): Promise<OwnershipKey[]> {
  if (standard === "ERC721") {
    const tokens = await prisma.token.findMany({ where: { chain: CHAIN, contractAddress }, select: { tokenId: true } });
    return tokens.map(({ tokenId }) => ({ standard, contractAddress, tokenId }));
  }
  const rows = await prisma.tokenBalance.findMany({
    where: { chain: CHAIN, contractAddress },
    select: { tokenId: true, owner: true },
  });
  return rows.map(({ tokenId, owner }) => ({ standard, contractAddress, tokenId, owner }));
}

async function repairCollection(contractAddress: string, standard: "ERC721" | "ERC1155", apply: boolean): Promise<Differences & { tokens: number }> {
  const keys = await keysFor(contractAddress, standard);
  const total: Differences = { changed: 0, removed: 0, added: 0 };
  for (let start = 0; start < keys.length; start += BATCH) {
    const batch = keys.slice(start, start + BATCH);
    const facts = await readOwnership(batch);
    const rows = await prisma.tokenBalance.findMany({
      where: { chain: CHAIN, contractAddress, tokenId: { in: [...new Set(batch.map((k) => k.tokenId))] } },
      select: { contractAddress: true, tokenId: true, owner: true, amount: true },
    });
    const diff = ownershipDifferences(rows, facts);
    total.changed += diff.changed;
    total.removed += diff.removed;
    total.added += diff.added;
    if (apply && diff.changed + diff.removed + diff.added > 0) {
      await prisma.$transaction((tx) => writeOwnership(tx, CHAIN, facts), { timeout: 60000 });
    }
    const done = Math.min(start + BATCH, keys.length);
    if (done % PROGRESS_EVERY < BATCH || done === keys.length) {
      console.error(`${contractAddress}: ${done}/${keys.length}`);
    }
  }
  return { tokens: keys.length, ...total };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const collections = await prisma.collection.findMany({
    where: { chain: CHAIN, standard: { in: ["ERC721", "ERC1155"] } },
    select: { contractAddress: true, standard: true },
    orderBy: { createdAt: "asc" },
  });
  const totals: Differences & { tokens: number } = { tokens: 0, changed: 0, removed: 0, added: 0 };
  console.log(apply ? "Repairing ownership" : "Dry run: comparing ownership, nothing is written");

  try {
    for (const { contractAddress, standard } of collections) {
      const result = await repairCollection(contractAddress, standard as "ERC721" | "ERC1155", apply);
      totals.tokens += result.tokens;
      totals.changed += result.changed;
      totals.removed += result.removed;
      totals.added += result.added;
      if (result.changed + result.removed + result.added > 0) console.log(JSON.stringify({ contract: contractAddress, ...result }));
    }
  } catch (err) {
    console.error("Stopped:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify({ total: totals }));
    await prisma.$disconnect();
  }
}

if (import.meta.main) await main();
