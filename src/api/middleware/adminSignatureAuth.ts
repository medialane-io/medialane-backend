import type { MiddlewareHandler } from "hono";
import {
  parseAdminHeaders, buildAdminSessionTypedData, verifyAdminRequestSig,
  sessionKeyHashOf, ADMIN_SCOPE,
} from "@medialane/sdk/starknet";
import type { AppEnv } from "../../types/hono.js";
import { verifyWalletSignature as realVerify } from "../../auth/verify.js";
import { isAdmin as realIsAdmin } from "../../auth/adminRole.js";
import { prismaNonceStore, type NonceStore } from "./adminNonceStore.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("mw:adminSignatureAuth");

export interface AdminSigDeps {
  verifyWalletSignature: typeof realVerify;
  isAdmin: (address: string) => Promise<boolean>;
  nonceStore: NonceStore;
  now?: () => number;
  skewSec?: number;
  maxTtlSec?: number;
}

export function createAdminSignatureAuth(deps: AdminSigDeps): MiddlewareHandler<AppEnv> {
  const skew = deps.skewSec ?? 120;
  const maxTtl = deps.maxTtlSec ?? 43_200;
  return async (c, next) => {
    const parsed = parseAdminHeaders((n) => c.req.header(n));
    if (!parsed) return c.json({ error: "Bad admin auth headers" }, 400);
    const { grant, sig, nonce, ts } = parsed;
    const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);

    if (grant.scope !== ADMIN_SCOPE) return c.json({ error: "Bad scope" }, 401);
    if (grant.issuedAt > nowSec || grant.expiresAt < nowSec) return c.json({ error: "Session expired" }, 401);
    if (grant.expiresAt - grant.issuedAt > maxTtl) return c.json({ error: "Session TTL too long" }, 401);
    if (sessionKeyHashOf(grant.sessionPublicKey) !== grant.sessionKeyHash) return c.json({ error: "Session key mismatch" }, 401);

    const data = buildAdminSessionTypedData({
      sessionKeyHash: grant.sessionKeyHash, scope: grant.scope,
      issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
    });
    let verdict;
    try {
      verdict = await deps.verifyWalletSignature({ chain: "STARKNET", address: grant.wallet, typedData: data, signature: grant.walletSig });
    } catch (err) {
      log.error({ err, wallet: grant.wallet }, "grant signature verify threw");
      return c.json({ error: "Signature verification failed" }, 401);
    }
    if (!verdict.ok) {
      return c.json({ error: verdict.reason === "not_deployed" ? "Wallet not deployed" : "Invalid grant" }, 401);
    }

    if (!(await deps.isAdmin(grant.wallet))) return c.json({ error: "Forbidden" }, 403);

    const path = c.req.path + (new URL(c.req.url).search || "");
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.text();
    const okSig = verifyAdminRequestSig(grant.sessionPublicKey, { method: c.req.method, path, body, nonce, ts }, sig);
    if (!okSig) return c.json({ error: "Bad request signature" }, 401);

    if (Math.abs(nowSec - ts) > skew) return c.json({ error: "Stale timestamp" }, 401);
    const fresh = await deps.nonceStore.consume(nonce, new Date((nowSec + skew) * 1000));
    if (!fresh) return c.json({ error: "Replay" }, 401);

    c.set("isAdmin", true);
    c.set("adminWallet", grant.wallet);
    await next();
  };
}

export const adminSignatureAuth = createAdminSignatureAuth({
  verifyWalletSignature: realVerify,
  isAdmin: realIsAdmin,
  nonceStore: prismaNonceStore,
});
