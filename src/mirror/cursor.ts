import { type Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cursor");

const CURSOR_ID = "singleton";

export interface Cursor {
  lastBlock: bigint;
  continuationToken: string | null;
}

export async function loadCursor(): Promise<Cursor> {
  const row = await prisma.indexerCursor.findUnique({
    where: { id: CURSOR_ID },
  });

  if (!row) {
    const startBlock = BigInt(env.INDEXER_START_BLOCK);
    log.info({ startBlock: startBlock.toString() }, "No cursor found, starting from START_BLOCK");
    return { lastBlock: startBlock, continuationToken: null };
  }

  return {
    lastBlock: row.lastBlock,
    continuationToken: row.continuationToken,
  };
}

export async function saveCursor(
  cursor: Cursor,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const client = tx ?? prisma;
  const data = {
    lastBlock: cursor.lastBlock,
    continuationToken: cursor.continuationToken,
  };
  await client.indexerCursor.upsert({
    where: { id: CURSOR_ID },
    create: { id: CURSOR_ID, ...data },
    update: data,
  });
}

export async function resetCursor(toBlock?: bigint): Promise<void> {
  const block = toBlock ?? BigInt(env.INDEXER_START_BLOCK);
  await prisma.indexerCursor.upsert({
    where: { id: CURSOR_ID },
    create: { id: CURSOR_ID, lastBlock: block, continuationToken: null },
    update: { lastBlock: block, continuationToken: null },
  });
  log.info({ block: block.toString() }, "Cursor reset");
}
