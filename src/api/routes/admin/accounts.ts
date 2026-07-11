/**
 * Account-scoped admin endpoints — the portal's server-side interface.
 *
 * The developer portal authenticates a wallet by signature, resolves the
 * AccountID, then calls these with the single portal service secret
 * (API_SECRET_KEY via adminSecretAuth) + the accountId. This is the
 * "master key + id" shape, but keyed on AccountID (not a bare address) and
 * gated behind the portal's signature auth — so it is not the spoofable model.
 *
 * Mirrors the per-tenant key logic in `tenants.ts`, scoped by `:id` (an
 * accountId). API keys + credits are Account state (07-identity §III).
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { Chain } from "@prisma/client";
import prisma from "../../../db/client.js";
import { generateApiKey } from "../../../utils/apiKey.js";
import { ensureAccountForWallet } from "../../../utils/account.js";
import { settlePayment } from "../../../payments/x402.js";
import { StarknetUsdcScheme } from "../../../payments/schemes/starknet.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("routes:admin:accounts");
const starknetScheme = new StarknetUsdcScheme();

export function registerAccountRoutes(admin: Hono) {
  // GET /admin/accounts — paginated account list for the portal admin console
  // (replaces the tenant list; Phase D). ?q= filters by id, name/email of a
  // linked identity, or wallet address.
  admin.get("/accounts", async (c) => {
    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const q = c.req.query("q")?.trim();

    const where = q
      ? {
          OR: [
            { id: q },
            { publicId: q },
            { identities: { some: { OR: [
              { address: { contains: q.toLowerCase() } },
              { email: { equals: q, mode: "insensitive" as const } },
            ] } } },
          ],
        }
      : {};

    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, publicId: true, type: true, plan: true, status: true,
          creditBalance: true, createdAt: true,
          identities: {
            select: { scheme: true, provider: true, chain: true, address: true, email: true },
            take: 3,
          },
          _count: { select: { apiKeys: true } },
        },
      }),
      prisma.account.count({ where }),
    ]);

    return c.json({
      data: accounts.map((a) => ({
        id: a.id,
        publicId: a.publicId,
        type: a.type,
        plan: a.plan,
        status: a.status,
        creditBalance: a.creditBalance,
        createdAt: a.createdAt,
        identities: a.identities,
        keyCount: a._count.apiKeys,
      })),
      meta: { page, limit, total },
    });
  });

  // POST /admin/accounts/resolve — find-or-create the Account for a wallet.
  admin.post("/accounts/resolve", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ chain: z.string().min(1), address: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return c.json({ error: "chain and address are required" }, 400);
    try {
      const r = await ensureAccountForWallet({
        chain: parsed.data.chain as Chain,
        address: parsed.data.address,
        appSource: "MEDIALANE_STARKNET",
      });
      return c.json({ data: { accountId: r.accountId, created: r.created } });
    } catch (err) {
      log.warn({ err, chain: parsed.data.chain }, "account resolve failed");
      return c.json({ error: "Invalid wallet (chain/address)" }, 400);
    }
  });

  // GET /admin/accounts/:id/keys — list the account's keys (no plaintext).
  admin.get("/accounts/:id/keys", async (c) => {
    const keys = await prisma.apiKey.findMany({
      where: { accountId: c.req.param("id") },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, prefix: true, label: true, appSource: true,
        status: true, lastUsedAt: true, createdAt: true,
      },
    });
    return c.json({ data: keys });
  });

  // POST /admin/accounts/:id/keys — mint a key (plaintext shown ONCE). Max 5 active.
  admin.post("/accounts/:id/keys", async (c) => {
    const accountId = c.req.param("id");
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
    if (!account) return c.json({ error: "Account not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ label: z.string().max(64).optional() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

    const active = await prisma.apiKey.count({ where: { accountId, status: "ACTIVE" } });
    if (active >= 5) return c.json({ error: "Max 5 active API keys per account" }, 409);

    const { plaintext, prefix, keyHash } = generateApiKey();
    const key = await prisma.apiKey.create({
      data: { accountId, prefix, keyHash, label: parsed.data.label ?? "default" },
      select: { id: true, prefix: true, label: true },
    });
    log.info({ keyId: key.id, accountId }, "admin minted account key");
    return c.json({ data: { id: key.id, prefix: key.prefix, label: key.label, plaintext } }, 201);
  });

  // DELETE /admin/accounts/:id/keys/:keyId — revoke (soft).
  admin.delete("/accounts/:id/keys/:keyId", async (c) => {
    const res = await prisma.apiKey.updateMany({
      where: { id: c.req.param("keyId"), accountId: c.req.param("id") },
      data: { status: "REVOKED" },
    });
    if (res.count === 0) return c.json({ error: "API key not found" }, 404);
    return c.json({ ok: true });
  });

  // GET /admin/accounts/:id/credits — balance + recent ledger.
  admin.get("/accounts/:id/credits", async (c) => {
    const accountId = c.req.param("id");
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { creditBalance: true } });
    if (!account) return c.json({ error: "Account not found" }, 404);
    const history = await prisma.payment.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, amountAtomic: true, creditedAmount: true, mdlnMultiplier: true, txHash: true, status: true, createdAt: true },
    });
    return c.json({ data: { balance: account.creditBalance, history } });
  });

  // POST /admin/accounts/:id/credits/fund — verify an on-chain USDC transfer and credit.
  admin.post("/accounts/:id/credits/fund", async (c) => {
    const accountId = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ txHash: z.string().min(3) }).safeParse(body);
    if (!parsed.success) return c.json({ error: "txHash is required" }, 400);
    const result = await settlePayment(starknetScheme, accountId, {
      scheme: starknetScheme.scheme,
      network: starknetScheme.network,
      txHash: parsed.data.txHash,
      nonce: "admin-account-fund",
    });
    if (!result.ok) return c.json({ error: result.reason ?? "Payment verification failed" }, 402);
    return c.json({ data: { credited: result.creditedAmount ?? 0 } });
  });

  // POST /admin/accounts/:id/credits/grant — admin credit adjustment (granted
  // credits for first-party apps; the account-native successor to the legacy
  // /admin/tenants/:id/credits grant). Floors at 0.
  admin.post("/accounts/:id/credits/grant", async (c) => {
    const accountId = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ amount: z.number().int() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "amount (int) is required" }, 400);
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { creditBalance: true } });
    if (!account) return c.json({ error: "Account not found" }, 404);
    const next = Math.max(0, account.creditBalance + parsed.data.amount);
    const updated = await prisma.account.update({
      where: { id: accountId },
      data: { creditBalance: next },
      select: { id: true, creditBalance: true },
    });
    log.info({ accountId, delta: parsed.data.amount, balance: updated.creditBalance }, "admin credit grant");
    return c.json({ data: { id: updated.id, creditBalance: updated.creditBalance } });
  });

  // GET /admin/accounts/:id/usage — per-key last-use telemetry. The old
  // monthly request counters were FREE-tier quota state; nothing has written
  // them since x402 credits became the meter (no free tier), so they were
  // dropped rather than served stale. Usage-in-credits lives on the Payment
  // ledger + Account.creditBalance.
  admin.get("/accounts/:id/usage", async (c) => {
    const keys = await prisma.apiKey.findMany({
      where: { accountId: c.req.param("id") },
      orderBy: { createdAt: "desc" },
      select: { prefix: true, label: true, status: true, lastUsedAt: true },
    });
    return c.json({ data: { keys } });
  });
}
