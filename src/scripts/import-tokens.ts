import { num } from "starknet";
import prisma from "../db/client.js";
import { readOwnership, type OwnershipFact } from "../chainRead/ownership.js";
import { writeOwnership } from "../mirror/handlers/ownership.js";
import { parseEvents } from "../mirror/parser.js";
import { getLatestBlock, pollContractEvents } from "../mirror/poller.js";
import { TRANSFER_SELECTOR, ZERO_ADDRESS } from "../config/constants.js";
import { normalizeAddress } from "../utils/starknet.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { sleep } from "../utils/retry.js";

const CHAIN = "STARKNET" as const;
const BATCH = 200;
const WRITE_BATCH = 20;
const PROGRESS_EVERY = 1000;
const WRITE_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;
const WRITE_TIMEOUT_MS = 90_000;
const DROPPED_CONNECTION_CODES = new Set(["P1001", "P1017", "P2028"]);
const DROPPED_CONNECTION_RE = /closed the connection|connection reset|kind: Closed|transaction already closed|write timed out/i;

type Totals = { minted: number; owned: number; burned: number; created: number; unchanged: number; ownersWritten: number };
type StoredBalance = { tokenId: string; owner: string; amount: string };
type RetryOptions = { attempts?: number; delayMs?: number; timeoutMs?: number; reconnect?: () => Promise<void> };

export function mintedTokenIds(events: RawStarknetEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of parseEvents(events)) {
    if (event.type === "Transfer" && event.from === ZERO_ADDRESS) ids.add(event.tokenId);
  }
  return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

export function ownedFacts(facts: OwnershipFact[]): OwnershipFact[] {
  return facts.filter((fact) => fact.standard === "ERC721" && fact.owner !== null);
}

export function isDroppedConnection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && DROPPED_CONNECTION_CODES.has(code)) return true;
  return typeof message === "string" && DROPPED_CONNECTION_RE.test(message);
}

export function ownershipToWrite(
  facts: OwnershipFact[],
  stored: StoredBalance[],
): { missing: { tokenId: string; owner: string }[]; changed: OwnershipFact[] } {
  const byToken = new Map<string, StoredBalance[]>();
  for (const row of stored) byToken.set(row.tokenId, [...(byToken.get(row.tokenId) ?? []), row]);
  const missing: { tokenId: string; owner: string }[] = [];
  const changed: OwnershipFact[] = [];
  for (const fact of facts) {
    if (fact.standard !== "ERC721" || fact.owner === null) continue;
    const rows = byToken.get(fact.tokenId) ?? [];
    if (rows.length === 0) missing.push({ tokenId: fact.tokenId, owner: fact.owner });
    else if (rows.length !== 1 || rows[0]!.owner !== fact.owner || rows[0]!.amount !== "1") changed.push(fact);
  }
  return { missing, changed };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Database write timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function retryOnDroppedConnection<T>(write: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = WRITE_ATTEMPTS,
    delayMs = RECONNECT_DELAY_MS,
    timeoutMs = WRITE_TIMEOUT_MS,
    reconnect = () => prisma.$disconnect(),
  } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(write(), timeoutMs);
    } catch (err) {
      if (attempt >= attempts || !isDroppedConnection(err)) throw err;
      console.error(`Database connection dropped, reconnecting and retrying the write (${attempt}/${attempts - 1})`);
      await reconnect().catch(() => undefined);
      await sleep(delayMs);
    }
  }
}

async function importCollection(contractAddress: string, apply: boolean): Promise<Totals> {
  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: CHAIN, contractAddress } },
    select: { standard: true, startBlock: true },
  });
  if (!collection) throw new Error(`${contractAddress} is not a registered collection`);
  if (collection.standard !== "ERC721") throw new Error(`${contractAddress} is not an ERC-721 collection`);

  const events = await pollContractEvents({
    address: contractAddress,
    fromBlock: Number(collection.startBlock),
    toBlock: await getLatestBlock(),
    keys: [[num.toHex(TRANSFER_SELECTOR)]],
  });
  const ids = mintedTokenIds(events);
  const totals: Totals = { minted: ids.length, owned: 0, burned: 0, created: 0, unchanged: 0, ownersWritten: 0 };

  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    const facts = ownedFacts(
      await readOwnership(batch.map((tokenId) => ({ standard: "ERC721" as const, contractAddress, tokenId }))),
    );
    totals.owned += facts.length;
    totals.burned += batch.length - facts.length;

    if (apply && facts.length > 0) {
      const created = await retryOnDroppedConnection(() => prisma.token.createMany({
        data: facts.map(({ tokenId }) => ({ chain: CHAIN, contractAddress, tokenId, metadataStatus: "PENDING" as const })),
        skipDuplicates: true,
      }));
      totals.created += created.count;

      const stored = await retryOnDroppedConnection(() => prisma.tokenBalance.findMany({
        where: { chain: CHAIN, contractAddress, tokenId: { in: facts.map((fact) => fact.tokenId) } },
        select: { tokenId: true, owner: true, amount: true },
      }));
      const { missing, changed } = ownershipToWrite(facts, stored);
      totals.unchanged += facts.length - missing.length - changed.length;

      if (missing.length > 0) {
        await retryOnDroppedConnection(() => prisma.tokenBalance.createMany({
          data: missing.map(({ tokenId, owner }) => ({ chain: CHAIN, contractAddress, tokenId, owner, amount: "1" })),
          skipDuplicates: true,
        }));
      }
      for (let w = 0; w < changed.length; w += WRITE_BATCH) {
        const chunk = changed.slice(w, w + WRITE_BATCH);
        await retryOnDroppedConnection(() =>
          prisma.$transaction((tx) => writeOwnership(tx, CHAIN, chunk), { maxWait: 10000, timeout: 60000 }));
      }
      totals.ownersWritten += missing.length + changed.length;
    }

    const done = Math.min(start + BATCH, ids.length);
    if (done % PROGRESS_EVERY < BATCH || done === ids.length) console.error(`${contractAddress}: ${done}/${ids.length}`);
  }
  return totals;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const addresses = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (addresses.length === 0) {
    console.error("Usage: import-tokens <contractAddress>... [--apply]");
    process.exitCode = 1;
    return;
  }
  console.log(apply ? "Importing tokens and current owners" : "Dry run: reading tokens and owners, nothing is written");

  try {
    for (const address of addresses) {
      const contractAddress = normalizeAddress(CHAIN, address);
      const totals = await importCollection(contractAddress, apply);
      console.log(JSON.stringify({ contract: contractAddress, ...totals }));
    }
  } catch (err) {
    console.error("Stopped:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) await main();
