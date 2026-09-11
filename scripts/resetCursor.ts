#!/usr/bin/env bun

import { resetCursor } from "../src/mirror/cursor.js";
import prisma from "../src/db/client.js";
import { env } from "../src/config/env.js";
import { type Chain } from "@prisma/client";

const args = process.argv.slice(2);
const blockArg = args.indexOf("--block");
const chainArg = args.indexOf("--chain");
const block = blockArg >= 0 ? BigInt(args[blockArg + 1]) : BigInt(env.INDEXER_START_BLOCK);
const chain: Chain = chainArg >= 0 ? (args[chainArg + 1] as Chain) : "STARKNET";

console.log(`Resetting ${chain} cursor to block ${block}...`);
await resetCursor(chain, block);
console.log("Done");
await prisma.$disconnect();
