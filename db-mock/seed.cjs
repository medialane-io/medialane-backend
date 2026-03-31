// db-mock/seed.cjs
/* eslint-disable @typescript-eslint/no-var-requires */
const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

function load(name) {
  const p = path.join(__dirname, "mock", `${name}.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const collections = load("collection");
  const tokens = load("token");
  const transfers = load("transfer");
  const indexerCursors = load("indexerCursor");
  const collectionProfiles = load("collectionProfile");
  const creatorProfiles = load("creatorProfile");
  const orders = load("order");
  const tenants = load("tenant");
  const apiKeys = load("apiKey");
  const webhookEndpoints = load("webhookEndpoint");
  const webhookDeliveries = load("webhookDelivery");
  const reports = load("report");
  const hiddenCreators = load("hiddenCreator");
  const collectionClaims = load("collectionClaim");
  const claimChallenges = load("claimChallenge");
  const transactionIntents = load("transactionIntent");

  // Idempotent upserts, using unique keys for each model

  for (const col of collections) {
    await prisma.collection.upsert({
      where: { id: col.id },
      update: col,
      create: col,
    });
  }

  for (const tok of tokens) {
    await prisma.token.upsert({
      where: { id: tok.id },
      update: tok,
      create: tok,
    });
  }

  for (const t of transfers) {
    await prisma.transfer.upsert({
      where: {
        chain_txHash_logIndex: {
          chain: t.chain,
          txHash: t.txHash,
          logIndex: t.logIndex,
        },
      },
      update: t,
      create: t,
    });
  }

  for (const c of indexerCursors) {
    await prisma.indexerCursor.upsert({
      where: { chain: c.chain },
      update: c,
      create: c,
    });
  }

  for (const cp of collectionProfiles) {
    await prisma.collectionProfile.upsert({
      where: {
        chain_contractAddress: {
          chain: cp.chain,
          contractAddress: cp.contractAddress,
        },
      },
      update: cp,
      create: cp,
    });
  }

  for (const cr of creatorProfiles) {
    await prisma.creatorProfile.upsert({
      where: { walletAddress: cr.walletAddress },
      update: cr,
      create: cr,
    });
  }

  for (const o of orders) {
    await prisma.order.upsert({
      where: { id: o.id },
      update: o,
      create: o,
    });
  }

  for (const t of tenants) {
    await prisma.tenant.upsert({
      where: { id: t.id },
      update: t,
      create: t,
    });
  }

  for (const k of apiKeys) {
    await prisma.apiKey.upsert({
      where: { id: k.id },
      update: k,
      create: k,
    });
  }

  for (const w of webhookEndpoints) {
    await prisma.webhookEndpoint.upsert({
      where: { id: w.id },
      update: w,
      create: w,
    });
  }

  for (const wd of webhookDeliveries) {
    await prisma.webhookDelivery.upsert({
      where: { id: wd.id },
      update: wd,
      create: wd,
    });
  }

  for (const r of reports) {
    await prisma.report.upsert({
      where: { id: r.id },
      update: r,
      create: r,
    });
  }

  for (const h of hiddenCreators) {
    await prisma.hiddenCreator.upsert({
      where: {
        chain_address: {
          chain: h.chain,
          address: h.address,
        },
      },
      update: h,
      create: h,
    });
  }

  for (const cc of collectionClaims) {
    await prisma.collectionClaim.upsert({
      where: { id: cc.id },
      update: cc,
      create: cc,
    });
  }

  for (const ch of claimChallenges) {
    await prisma.claimChallenge.upsert({
      where: { id: ch.id },
      update: ch,
      create: ch,
    });
  }

  for (const ti of transactionIntents) {
    await prisma.transactionIntent.upsert({
      where: { id: ti.id },
      update: ti,
      create: ti,
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    const dbUrl = process.env.DATABASE_URL || "(DATABASE_URL not set)";
    console.log("Seed completed.");
    console.log("Using DATABASE_URL:", dbUrl);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

