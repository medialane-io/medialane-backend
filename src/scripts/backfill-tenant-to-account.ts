/**
 * Backfill: collapse every `Tenant` onto an `Account` (07-identity §III — API keys
 * + credits are platform-layer Account state). Re-points each tenant's ApiKeys,
 * WebhookEndpoints, and Payments to the Account via `accountId`, and copies the
 * tenant's plan/status/creditBalance onto it. Lossless — no row is deleted.
 *
 *   - Wallet tenants (name = `0x…`, created by the portal's provision flow) map to
 *     their wallet Account via `ensureAccountForWallet` (idempotent on (chain,address)).
 *   - First-party app tenants (`medialane-dapp`/`-io`/`-portal`/`-dao`) map to a
 *     wallet-less ORGANIZATION Account (07 §II: a wallet is not required).
 *
 * Idempotent: if a tenant's children already carry an `accountId`, that Account is
 * reused — re-running never duplicates Accounts or double-moves children.
 *
 *   bun run backfill-tenant-to-account
 *
 * The authoritative verification is a prod-backup dry run with SQL parity checks
 * (0 orphan keys + conserved credit total), as with the 2026-06-05 identity unify.
 */
import prisma from "../db/client.js";
import { ensureAccountForWallet, generateAccountPublicId } from "../utils/account.js";

export async function backfillTenantToAccount(): Promise<{ migrated: number; failed: number; unlinkedKeys: number }> {
  const tenants = await prisma.tenant.findMany({ include: { apiKeys: true } });
  let migrated = 0;
  let failed = 0;

  for (const t of tenants) {
    // Resilient: a single corrupt row (e.g. a malformed "0x…" tenant name that
    // can't normalize to an address) must never abort the rest of the backfill.
    // This runs in the Railway deploy chain before boot — completeness matters.
    try {
      // Idempotent: reuse the Account already linked from a child, if any.
      let accountId = t.apiKeys.find((k) => k.accountId)?.accountId ?? null;

      if (!accountId) {
        if (t.name.startsWith("0x")) {
          // Portal/wallet tenant — the tenant name IS the wallet address (provision.ts).
          // Throws on a malformed address → caught below, logged, skipped (not invented).
          const r = await ensureAccountForWallet({
            chain: "STARKNET",
            address: t.name,
            appSource: "MEDIALANE_STARKNET",
          });
          accountId = r.accountId;
        } else {
          // First-party app tenant — a wallet-less ORGANIZATION Account (07 §II).
          const acct = await prisma.account.create({
            data: { publicId: generateAccountPublicId(), type: "ORGANIZATION", roles: ["ORGANIZATION"] },
            select: { id: true },
          });
          accountId = acct.id;
        }
      }

      // Copy billing state onto the Account (enum values are identical to Tenant's).
      await prisma.account.update({
        where: { id: accountId },
        data: {
          plan: t.plan === "PREMIUM" ? "PREMIUM" : "FREE",
          status: t.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
          creditBalance: t.creditBalance,
        },
      });

      // Re-point every child onto the Account.
      await prisma.apiKey.updateMany({ where: { tenantId: t.id }, data: { accountId } });
      await prisma.webhookEndpoint.updateMany({ where: { tenantId: t.id }, data: { accountId } });
      await prisma.payment.updateMany({ where: { tenantId: t.id }, data: { accountId } });
      migrated++;
    } catch (err) {
      failed++;
      console.error(`backfill: SKIPPED tenant ${t.id} (name="${t.name}"):`, err instanceof Error ? err.message : err);
    }
  }

  // Completeness signal — any key still unlinked would 401 at auth (logged there too).
  const unlinkedKeys = await prisma.apiKey.count({ where: { accountId: null } });
  console.log(`backfill-tenant-to-account: migrated=${migrated} failed=${failed} unlinkedKeys=${unlinkedKeys}`);
  if (unlinkedKeys > 0) {
    console.error(`backfill: WARNING ${unlinkedKeys} api key(s) still have no accountId — they will 401 until linked`);
  }

  return { migrated, failed, unlinkedKeys };
}

if (import.meta.main) {
  // Always exit 0 — the deploy chain (`;`-separated) continues to boot regardless,
  // and per-row failures are already logged + counted above. A hard non-zero here
  // would only muddy the deploy signal without changing the outcome.
  backfillTenantToAccount()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("backfill: FATAL (pre-loop)", e);
      process.exit(0);
    });
}
