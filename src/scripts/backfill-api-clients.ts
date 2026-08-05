import prisma from "../db/client.js";

/**
 * One-shot backfill: create an ApiClient for every Account that has billing
 * state under the OLD schema shape (Account.plan/creditBalance, or a
 * still-accountId-scoped ApiKey/WebhookEndpoint/Payment/BusinessProvisioning
 * row from before the ApiClient code cutover), and point every such child
 * row's new apiClientId at it. Idempotent — re-running is safe (upserts by
 * accountId). Must run BEFORE the code cutover deploys (apiKeyAuth etc. read
 * apiClientId once live) — see
 * docs/superpowers/specs/2026-08-05-api-client-model-design.md.
 *
 * Run with --dry-run to report counts without writing anything.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const accountIds = new Set<string>();
  const [billedAccounts, keyAccounts, webhookAccounts, paymentAccounts, provisioningAccounts] = await Promise.all([
    prisma.account.findMany({ where: { OR: [{ plan: "PREMIUM" }, { creditBalance: { not: 0 } }] }, select: { id: true } }),
    prisma.apiKey.findMany({ where: { apiClientId: null }, select: { accountId: true }, distinct: ["accountId"] }),
    prisma.webhookEndpoint.findMany({ where: { apiClientId: null }, select: { accountId: true }, distinct: ["accountId"] }),
    prisma.payment.findMany({ where: { apiClientId: null }, select: { accountId: true }, distinct: ["accountId"] }),
    prisma.businessProvisioning.findMany({ where: { apiClientId: null }, select: { accountId: true }, distinct: ["accountId"] }),
  ]);
  for (const a of billedAccounts) accountIds.add(a.id);
  for (const a of keyAccounts) accountIds.add(a.accountId);
  for (const a of webhookAccounts) accountIds.add(a.accountId);
  for (const a of paymentAccounts) accountIds.add(a.accountId);
  for (const a of provisioningAccounts) accountIds.add(a.accountId);

  console.log(`Found ${accountIds.size} accounts needing an ApiClient.`);
  if (dryRun) {
    console.log("--dry-run: no writes performed.");
    return;
  }

  let created = 0;
  for (const accountId of accountIds) {
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { plan: true, creditBalance: true } });
    if (!account) continue;

    const apiClient = await prisma.apiClient.upsert({
      where: { accountId },
      create: { accountId, plan: account.plan, creditBalance: account.creditBalance },
      update: {},
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.apiKey.updateMany({ where: { accountId, apiClientId: null }, data: { apiClientId: apiClient.id } }),
      prisma.webhookEndpoint.updateMany({ where: { accountId, apiClientId: null }, data: { apiClientId: apiClient.id } }),
      prisma.payment.updateMany({ where: { accountId, apiClientId: null }, data: { apiClientId: apiClient.id } }),
      prisma.businessProvisioning.updateMany({ where: { accountId, apiClientId: null }, data: { apiClientId: apiClient.id } }),
    ]);
    created++;
  }

  console.log(`Created/verified ${created} ApiClient rows.`);

  const stillUnlinked = await Promise.all([
    prisma.apiKey.count({ where: { apiClientId: null } }),
    prisma.webhookEndpoint.count({ where: { apiClientId: null } }),
    prisma.payment.count({ where: { apiClientId: null } }),
    prisma.businessProvisioning.count({ where: { apiClientId: null } }),
  ]);
  console.log(`Remaining unlinked rows (must be 0 before the code cutover deploys): keys=${stillUnlinked[0]} webhooks=${stillUnlinked[1]} payments=${stillUnlinked[2]} provisioning=${stillUnlinked[3]}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
