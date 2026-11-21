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
const DROPPED_CONNECTION_CODES = new Set(["P1001", "P1017", "P2028"]);
const DROPPED_CONNECTION_RE = /closed the connection|connection reset|kind: Closed|transaction already closed/i;

type Totals = { minted: number; owned: number; burned: number; created: number };

/** Token ids minted by an ERC-721 contract, in ascending numeric order. */
export function mintedTokenIds(events: RawStarknetEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of parseEvents(events)) {
    if (event.type === "Transfer" && event.from === ZERO_ADDRESS) ids.add(event.tokenId);
  }
  return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/** The facts for tokens that currently have an owner; burned tokens are left out. */
export function ownedFacts(facts: OwnershipFact[]): OwnershipFact[] {
  return facts.filter((fact) => fact.standard === "ERC721" && fact.owner !== null);
}

/** True when the database connection dropped during a write, so the write can be repeated on a new one. */
export function isDroppedConnection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && DROPPED_CONNECTION_CODES.has(code)) return true;
  return typeof message === "string" && DROPPED_CONNECTION_RE.test(message);
}

/** Runs an idempotent write, repeating it when the database connection drops; any other error is thrown at once. */
export async function retryOnDroppedConnection<T>(
  write: () => Promise<T>,
  attempts = WRITE_ATTEMPTS,
  delayMs = RECONNECT_DELAY_MS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (attempt >= attempts || !isDroppedConnection(err)) throw err;
      console.error(`Database connection dropped, retrying the write (${attempt}/${attempts - 1})`);
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
  const totals: Totals = { minted: ids.length, owned: 0, burned: 0, created: 0 };

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
      for (let w = 0; w < facts.length; w += WRITE_BATCH) {
        const chunk = facts.slice(w, w + WRITE_BATCH);
        await retryOnDroppedConnection(() =>
          prisma.$transaction((tx) => writeOwnership(tx, CHAIN, chunk), { maxWait: 10000, timeout: 60000 }));
      }
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
