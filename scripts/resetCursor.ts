#!/usr/bin/env bun
/**
 *  Dev utility to reset the indexer cursor.
 * Usage: bun run scripts/resetCursor.ts [--block <number>]
 */

import { resetCursor } from "../src/mirror/cursor.js";
import prisma from "../src/db/client.js";
import { env } from "../src/config/env.js";

const args = process.argv.slice(2);
const blockArg = args.indexOf("--block");
const block = blockArg >= 0 ? BigInt(args[blockArg + 1]) : BigInt(env.INDEXER_START_BLOCK);

console.log(`Resetting cursor to block ${block}...`);
await resetCursor(block);
console.log("Done");
await prisma.$disconnect();
