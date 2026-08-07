import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { ensureAccountForWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";
import type { AppSource } from "@prisma/client";
import { Chain } from "@prisma/client";
import { APP_SOURCE_INPUT, normalizeAppSource } from "../../utils/appSource.js";
import { IDENTITY_SCHEME } from "../../utils/identity.js";
import { verifyEmailVerifiedToken } from "../../utils/emailVerificationToken.js";

const users = new Hono<AppEnv>();

// walletType is a free-form wallet-software label on the wallet Identity — no longer
// a closed enum (the WalletType enum was dropped in the identity unification, 07 §II,
// permissionless). We accept any short string and lowercase it into Identity.provider;
// the platform never gates on it. Apps may send "braavos"/"ready"/"chipipay"/… (any case).
const walletTypeSchema = z.string().max(64);
const appSourceEnum = z.enum(APP_SOURCE_INPUT);
const chainEnum = z.nativeEnum(Chain);

const VALID_CHAINS = new Set<Chain>(Object.values(Chain));
const VALID_APP_SOURCES = new Set<AppSource>([
  "MEDIALANE_STARKNET", "MEDIALANE_IO", "MEDIALANE_PORTAL", "MEDIALANE_SDK",
]);

const registerBodySchema = z.object({
  walletAddress: z.string().min(1, "walletAddress is required"),
  walletType: walletTypeSchema.optional(),
  appSource: appSourceEnum.optional(),
  chain: chainEnum.optional(),
});

const meBodySchema = z.object({
  walletType: walletTypeSchema.optional(),
  appSource: appSourceEnum.optional(),
  // 07-identity §I: the Wallet identifier is (chain, address). Accepting
  // `chain` from the client lets callers explicitly assert the chain
  // they're registering — currently always STARKNET, but locking the
  // shape in v1 is what keeps the year-2 multichain path unblocked.
  // Optional and defaults to STARKNET so older clients keep working.
  chain: chainEnum.optional(),
  // Collected at signup, unverified. Additive only — never blocks
  // registration, never overwrites an existing Identity row (whether it
  // already belongs to this account or a different one). Verification
  // happens later, opt-in, from settings (see emailVerificationToken).
  email: z.string().email().optional(),
  // Proves the caller's email was verified moments ago via a one-time code
  // (io's /wallet-onboarding flow). Additive only — missing/expired/invalid
  // never blocks registration (email is a label, never a gate; 07 §II).
  emailVerificationToken: z.string().optional(),
});

/**
 * POST /v1/users/register
 * Frictionless registration — authenticated by tenant API key.
 * Address provided in body. Idempotent: returns existing Account if already known.
 */
users.post(
  "/register",
  zValidator("json", registerBodySchema),
  async (c) => {
    const body = c.req.valid("json");
    const provider = (body.walletType ?? "UNKNOWN").toLowerCase();
    const appSource = normalizeAppSource(body.appSource ?? "MEDIALANE_STARKNET");
    const chain: Chain = body.chain ?? "STARKNET";

    const { accountId } = await ensureAccountForWallet({
      chain,
      address: body.walletAddress,
      provider,
      appSource,
    });

    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      include: {
        identities: {
          where: { scheme: IDENTITY_SCHEME.WALLET, chain, address: normalizeAddress(chain, body.walletAddress) },
          take: 1,
        },
      },
    });
    const wallet = account.identities[0]!;
    return c.json({
      accountId: account.id,
      publicId: account.publicId,
      walletAddress: wallet.address,
      chain: wallet.chain,
      provider: wallet.provider,
      appSource,
      createdAt: account.createdAt,
    });
  }
);

/**
 * POST /v1/users/me
 * Upsert the JWT-authenticated caller's account.
 * Works with both Clerk JWT (medialane-io) and SIWS token (medialane-starknet).
 */
users.post("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = meBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const provider = (parsed.data.walletType ?? "UNKNOWN").toLowerCase();
  const appSource = normalizeAppSource(parsed.data.appSource ?? "MEDIALANE_IO");
  const chain: Chain = parsed.data.chain ?? "STARKNET";

  // identityAuth only issues tokens for Starknet wallets in v1 (Clerk JWT
  // carries a ChipiPay Starknet address; SIWS proves a Starknet signature).
  // Accepting a non-STARKNET chain from the body would mis-register a
  // Starknet-derived address under another chain. When SIWE / SIWB land
  // and identityAuth issues tokens for other chains, this guard relaxes.
  if (chain !== "STARKNET") {
    return c.json({
      error: "Only STARKNET is supported on /v1/users/me in v1 — cross-chain registration arrives with SIWE/SIWB",
    }, 400);
  }

  const { accountId } = await ensureAccountForWallet({
    chain,
    address: walletAddress,
    provider,
    appSource,
  });

  if (parsed.data.email) {
    const existing = await prisma.identity.findUnique({
      where: { scheme_value: { scheme: IDENTITY_SCHEME.EMAIL, value: parsed.data.email } },
      select: { id: true },
    });
    if (!existing) {
      await prisma.identity.create({
        data: {
          accountId,
          scheme: IDENTITY_SCHEME.EMAIL,
          value: parsed.data.email,
          email: parsed.data.email,
          appSource,
          verifiedAt: null,
        },
      });
    }
    // Already attached (to this account or a different one) — leave it
    // exactly as-is. Never downgrade a verified email, never reassign
    // someone else's.
  }

  if (parsed.data.emailVerificationToken) {
    const email = verifyEmailVerifiedToken(parsed.data.emailVerificationToken);
    if (email) {
      await prisma.identity.upsert({
        where: { scheme_value: { scheme: IDENTITY_SCHEME.EMAIL, value: email } },
        create: {
          accountId,
          scheme: IDENTITY_SCHEME.EMAIL,
          value: email,
          email,
          appSource,
          verifiedAt: new Date(),
        },
        update: { verifiedAt: new Date() },
      });
    }
    // Invalid/expired token: silently skip. Email is additive, never a gate
    // (07-identity-model.md §II) — registration must not fail on it.
  }

  return c.json({ walletAddress });
});

/**
 * GET /v1/users/me
 * Return the JWT-authenticated caller's account info, or 404.
 */
users.get("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const identity = await prisma.identity.findUnique({
    where: { chain_address: { chain: "STARKNET", address: walletAddress } },
    include: {
      account: {
        include: {
          identities: { where: { scheme: IDENTITY_SCHEME.EMAIL }, take: 1 },
        },
      },
    },
  });
  if (!identity) return c.json({ error: "User not found" }, 404);
  const emailIdentity = identity.account.identities[0];
  return c.json({
    walletAddress: identity.address,
    accountId: identity.account.id,
    publicId: identity.account.publicId,
    email: emailIdentity?.email ?? null,
    emailVerified: emailIdentity ? emailIdentity.verifiedAt !== null : false,
  });
});

/**
 * GET /v1/users/count
 * Returns account count with optional filters.
 * Auth: tenant API key. Used for Starknet Foundation grant reporting.
 *
 * Filters all delegate to Identity (chain, provider, appSource) — an Account
 * with any matching Identity is counted once, regardless of how many it has.
 */
users.get(
  "/count",
  async (c) => {
    const { chain, appSource, walletType, since } = c.req.query();

    const identityWhere: Record<string, unknown> = {};
    if (chain && VALID_CHAINS.has(chain as Chain)) identityWhere.chain = chain;
    if (walletType) identityWhere.provider = walletType.toLowerCase();
    if (appSource && VALID_APP_SOURCES.has(normalizeAppSource(appSource)))
      identityWhere.appSource = normalizeAppSource(appSource);

    const accountWhere: Record<string, unknown> = {};
    if (Object.keys(identityWhere).length > 0) accountWhere.identities = { some: identityWhere };
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) accountWhere.createdAt = { gte: sinceDate };
    }

    const count = await prisma.account.count({ where: accountWhere });
    return c.json({ count, filters: { chain, appSource, walletType, since } });
  }
);

export default users;
