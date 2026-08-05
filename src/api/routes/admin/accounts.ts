/**
 * Account-scoped admin endpoints — identity only (search, suspend/reactivate,
 * resolve-by-wallet). Billing (plan/credits/keys/webhooks) lives on the
 * caller's ApiClient, if it has one — see ./apiClients.ts and
 * docs/superpowers/specs/2026-08-05-api-client-model-design.md.
 *
 * The developer portal authenticates a wallet by signature, resolves the
 * AccountID, then calls these with the single portal service secret
 * (API_SECRET_KEY via adminSecretAuth) + the accountId. This is the
 * "master key + id" shape, but keyed on AccountID (not a bare address) and
 * gated behind the portal's signature auth — so it is not the spoofable model.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { Chain } from "@prisma/client";
import prisma from "../../../db/client.js";
import { ensureAccountForWallet } from "../../../utils/account.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("routes:admin:accounts");

export function registerAccountRoutes(admin: Hono) {
  // GET /admin/accounts — paginated account list for the portal admin console
  // (replaces the tenant list; Phase D). ?q= filters by id, name/email of a
  // linked identity, or wallet address. Each row's `apiClient` is null unless
  // this account is also an SDK/API consumer.
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
          id: true, publicId: true, type: true, status: true, createdAt: true,
          identities: {
            select: { scheme: true, provider: true, chain: true, address: true, email: true },
            take: 3,
          },
          apiClient: {
            select: {
              id: true, plan: true, creditBalance: true,
              _count: { select: { apiKeys: true } },
            },
          },
        },
      }),
      prisma.account.count({ where }),
    ]);

    return c.json({
      data: accounts.map((a) => ({
        id: a.id,
        publicId: a.publicId,
        type: a.type,
        status: a.status,
        createdAt: a.createdAt,
        identities: a.identities,
        apiClient: a.apiClient
          ? { id: a.apiClient.id, plan: a.apiClient.plan, creditBalance: a.apiClient.creditBalance, keyCount: a.apiClient._count.apiKeys }
          : null,
      })),
      meta: { page, limit, total },
    });
  });

  // PATCH /admin/accounts/:id — update status (suspend = every key on this
  // account's ApiClient, if any, stops authenticating; apiKeyAuth checks
  // account.status regardless of billing state).
  admin.patch("/accounts/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({
      status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    }).safeParse(body);
    if (!parsed.success || !parsed.data.status) {
      return c.json({ error: "Provide status" }, 400);
    }
    try {
      const account = await prisma.account.update({
        where: { id: c.req.param("id") },
        data: parsed.data,
        select: { id: true, status: true },
      });
      log.info({ accountId: account.id, ...parsed.data }, "admin account update");
      return c.json({ data: account });
    } catch {
      return c.json({ error: "Account not found" }, 404);
    }
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
}
