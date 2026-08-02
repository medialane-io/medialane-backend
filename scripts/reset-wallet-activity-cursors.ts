#!/usr/bin/env bun

import prisma from "../src/db/client.js";

const { count } = await prisma.walletActivityCursor.deleteMany({});
console.log(`Deleted ${count} WalletActivityCursor row(s). Every account will fully resync on next /v1/wallet-activity request.`);
await prisma.$disconnect();
