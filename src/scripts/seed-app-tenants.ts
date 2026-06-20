/**
 * Provision the four first-party app tenants — each with its OWN tenant, its OWN
 * API key, and its OWN credit balance. No shared key across apps: a leaked key
 * only burns that app's credits (blast-radius isolation).
 *
 * Metering is uniform on /v1/* (the revenue model); these apps aren't external
 * clients, so they run on granted credits instead of paying USDC. External
 * agents/devs get their own tenants (balance 0) and pay via x402.
 *
 * Idempotent: re-running upserts the tenants, tops each balance up to the floor,
 * and only mints a key if the app has no active key yet (keys can't be re-shown,
 * so the plaintext is printed once on creation — capture it into that app's env).
 *
 *   bun run seed-app-tenants
 *
 * NOTE (tenant→account cutover): credits + keys are now Account state (07 §III).
 * The deploy-chain backfill (`backfill-tenant-to-account`) maps each app tenant to
 * a wallet-less ORGANIZATION Account and re-points its keys/credits — so the app
 * keys this script already created keep working and bill the Account. This script
 * still writes Tenant rows (it only mints a key when none exists, so it won't
 * create un-authenticatable tenant-only keys for already-seeded apps); the
 * Tenant top-up below no longer feeds billing. Account top-ups go through
 * `POST /admin/accounts/:id/credits/grant`. Full account-native rewrite of this
 * script is a Phase D follow-up (when the Tenant model is dropped).
 */
import prisma from "../db/client.js";
import { generateApiKey } from "../utils/apiKey.js";
import type { AppSource } from "@prisma/client";

// First-party apps run on granted credits; topped up to this floor each run.
const CREDIT_FLOOR = 1_000_000;

const APPS: { name: string; email: string; appSource: AppSource }[] = [
  { name: "medialane-dapp", email: "medialanedapp@gmail.com", appSource: "MEDIALANE_STARKNET" },
  { name: "medialane-io", email: "medialaneio@gmail.com", appSource: "MEDIALANE_IO" },
  { name: "medialane-portal", email: "medialanexyz@gmail.com", appSource: "MEDIALANE_PORTAL" },
  { name: "medialane-dao", email: "medialanedao@gmail.com", appSource: "MEDIALANE_DAO" },
];

async function main() {
  for (const app of APPS) {
    const tenant = await prisma.tenant.upsert({
      where: { email: app.email },
      update: {},
      create: { name: app.name, email: app.email, plan: "PREMIUM" },
    });

    // Top up to the floor (never reduce a higher balance).
    if (tenant.creditBalance < CREDIT_FLOOR) {
      await prisma.tenant.update({ where: { id: tenant.id }, data: { creditBalance: CREDIT_FLOOR } });
    }

    const existing = await prisma.apiKey.findFirst({
      where: { tenantId: tenant.id, appSource: app.appSource, status: "ACTIVE" },
      select: { prefix: true },
    });
    if (existing) {
      console.log(`✓ ${app.name}: tenant ${tenant.id} — key ${existing.prefix}… — balance ≥ ${CREDIT_FLOOR.toLocaleString()}`);
      continue;
    }

    const { plaintext, prefix, keyHash } = generateApiKey();
    await prisma.apiKey.create({
      data: { tenantId: tenant.id, prefix, keyHash, label: app.name, appSource: app.appSource },
    });
    console.log(`★ ${app.name}: NEW KEY (shown once — set in this app's env): ${plaintext}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
