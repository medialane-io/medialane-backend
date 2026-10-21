import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { identityAuth, identityAuthWalletOptional } from "../middleware/identityAuth.js";
import { accountWallet, ensureAccountForWallet, liveEmailWhere, replaceEmail, replaceWallet, WalletAlreadyAttachedError } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";
import { Chain } from "@prisma/client";
import { callerApp } from "../../utils/caller.js";
import { IDENTITY_SCHEME, emailValues, normalizeIdentityValue } from "../../utils/identity.js";
import { currentAccountIdFromSession } from "../../utils/accountSession.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";
import { getCurrentEmailIdentity, canClaimEmail, shouldAddEmailIdentity } from "../../utils/emailVerification.js";
import { issueVerificationCode } from "./auth-email.js";
import { createLogger } from "../../utils/logger.js";
import { emailDeadlineFor } from "../../utils/emailDeadline.js";
import { needsKeySetup, setupWalletKey, productionWalletKeyDeps } from "../../provisioning/walletKey.js";

const log = createLogger("routes:users");

const users = new Hono<AppEnv>();

const walletTypeSchema = z.string().max(64);
const chainEnum = z.nativeEnum(Chain);

const VALID_CHAINS = new Set<Chain>(Object.values(Chain));

const registerBodySchema = z.object({
  walletAddress: z.string().min(1, "walletAddress is required"),
  walletType: walletTypeSchema.optional(),
  chain: chainEnum.optional(),
});

const meBodySchema = z.object({
  walletType: walletTypeSchema.optional(),

  chain: chainEnum.optional(),

  email: z.string().email().optional(),

});

const generateWalletBodySchema = z.object({

  newWalletSiwsToken: z.string(),
});

users.post(
  "/register",
  zValidator("json", registerBodySchema),
  async (c) => {
    const body = c.req.valid("json");
    const provider = (body.walletType ?? "UNKNOWN").toLowerCase();
    const appId = callerApp(c);
    const chain: Chain = body.chain ?? "STARKNET";

    const { accountId } = await ensureAccountForWallet({
      chain,
      address: body.walletAddress,
      provider,
      appId,
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
      createdAt: account.createdAt,
    });
  }
);

users.post("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = meBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const provider = (parsed.data.walletType ?? "UNKNOWN").toLowerCase();
  const appId = callerApp(c);
  const chain: Chain = parsed.data.chain ?? "STARKNET";

  if (chain !== "STARKNET") {
    return c.json({
      error: "Only STARKNET is supported on /v1/users/me in v1 — cross-chain registration arrives with SIWE/SIWB",
    }, 400);
  }

  const session = c.req.header("x-account-session");
  const linkToAccountId = session ? ((await currentAccountIdFromSession(session)) ?? undefined) : undefined;

  let accountId: string;
  try {
    ({ accountId } = await ensureAccountForWallet({
      chain,
      address: walletAddress,
      provider,
      appId,
      linkToAccountId,
    }));
  } catch (err) {
    if (err instanceof WalletAlreadyAttachedError) {
      return c.json({ error: "wallet_already_attached", message: "This account already has a wallet." }, 409);
    }
    throw err;
  }

  if (parsed.data.email) {
    const existing = await prisma.identity.findFirst({
      where: liveEmailWhere(appId, emailValues(parsed.data.email)),
      select: { id: true },
    });
    if (shouldAddEmailIdentity({ emailHeldByAnyAccount: existing !== null, accountHasEmail: (await getCurrentEmailIdentity(accountId)) !== null })) {
      await prisma.identity.create({
        data: {
          accountId,
          scheme: IDENTITY_SCHEME.EMAIL,
          value: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, parsed.data.email),
          appId,
        },
      });
      issueVerificationCode(parsed.data.email, appId).catch((err: unknown) => {
        log.error({ err }, "Failed to auto-send verification code");
      });
    }

  }

  return c.json({ walletAddress });
});

users.post("/me/generate-wallet", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = generateWalletBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }

  const newWalletId = verifySiwsToken(parsed.data.newWalletSiwsToken);
  if (!newWalletId) {
    return c.json({ error: "Invalid or expired token for the new wallet" }, 400);
  }

  const existing = await prisma.identity.findUnique({
    where: { appId_chain_address: { appId: callerApp(c), chain: "STARKNET", address: walletAddress } },
    select: { accountId: true },
  });
  if (!existing) return c.json({ error: "Account not found" }, 404);

  const newAddress = normalizeAddress(newWalletId.chain, newWalletId.address);
  const appId = callerApp(c);

  await replaceWallet({
    accountId: existing.accountId,
    appId,
    chain: newWalletId.chain,
    address: newAddress,
  });

  return c.json({ walletAddress: newAddress });
});

users.post("/me/wallet", async (c) => {
  const session = c.req.header("x-account-session");
  const accountId = session ? await currentAccountIdFromSession(session) : null;
  if (!accountId) return c.json({ error: "Invalid or expired session" }, 401);

  const walletAddress = await accountWallet(accountId);
  if (!walletAddress) return c.json({ walletAddress: null });
  const keySetup = await needsKeySetup(productionWalletKeyDeps, accountId, walletAddress).catch((err) => {
    log.warn({ err, accountId }, "could not read the wallet's owners; login goes on without the key setup");
    return false;
  });
  return c.json({ walletAddress, needsKeySetup: keySetup });
});

const walletKeySchema = z.object({
  newOwnerPubkey: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
});

users.post("/me/wallet/key", zValidator("json", walletKeySchema), async (c) => {
  const { newOwnerPubkey } = c.req.valid("json");
  const session = c.req.header("x-account-session");
  const accountId = session ? await currentAccountIdFromSession(session) : null;
  if (!accountId) return c.json({ error: "Invalid or expired session" }, 401);
  const outcome = await setupWalletKey(productionWalletKeyDeps, accountId, newOwnerPubkey);
  if (outcome.status !== 200) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ walletAddress: outcome.walletAddress, removeOwnerGuid: outcome.removeOwnerGuid });
});

users.get("/me", async (c, next) => identityAuthWalletOptional(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") ?? null;
  const accountId =
    c.get("sessionAccountId") ??
    (walletAddress
      ? (
          await prisma.identity.findUnique({
            where: { appId_chain_address: { appId: callerApp(c), chain: "STARKNET", address: walletAddress } },
            select: { accountId: true },
          })
        )?.accountId
      : undefined);
  if (!accountId) return c.json({ error: "User not found" }, 404);
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { publicId: true, status: true, createdAt: true },
  });
  const emailIdentity = await getCurrentEmailIdentity(accountId);
  const emailDeadline = emailDeadlineFor({
    status: account.status,
    createdAt: account.createdAt,
    hasEmail: emailIdentity !== null,
  });
  return c.json({
    walletAddress,
    accountId,
    publicId: account.publicId,
    email: emailIdentity?.email ?? null,
    emailDeadline: emailDeadline?.toISOString() ?? null,
  });
});

const changeEmailSchema = z.object({ email: z.string().email() });

users.post("/me/email", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = changeEmailSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const email = parsed.data.email;
  const appId = callerApp(c);

  const identity = await prisma.identity.findUnique({
    where: { appId_chain_address: { appId: callerApp(c), chain: "STARKNET", address: walletAddress } },
    select: { accountId: true },
  });
  if (!identity) return c.json({ error: "User not found" }, 404);
  const accountId = identity.accountId;

  const existingOwner = await prisma.identity.findFirst({
    where: liveEmailWhere(appId, emailValues(email)),
    select: { accountId: true },
  });
  const decision = canClaimEmail(accountId, existingOwner);
  if (!decision.allowed) {
    const message = decision.reason === "already-yours"
      ? "That's already your current email."
      : "That email is already in use on another account.";
    return c.json({ error: message }, 409);
  }

  await replaceEmail({ accountId, appId, email });

  await issueVerificationCode(email, appId);

  return c.json({ email });
});

users.get(
  "/count",
  async (c) => {
    const { chain, appId, walletType, since } = c.req.query();

    const identityWhere: Record<string, unknown> = {};
    if (chain && VALID_CHAINS.has(chain as Chain)) identityWhere.chain = chain;
    if (walletType) identityWhere.provider = walletType.toLowerCase();
    if (appId) identityWhere.appId = appId;

    const accountWhere: Record<string, unknown> = {};
    if (Object.keys(identityWhere).length > 0) accountWhere.identities = { some: identityWhere };
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) accountWhere.createdAt = { gte: sinceDate };
    }

    const count = await prisma.account.count({ where: accountWhere });
    return c.json({ count, filters: { chain, appId, walletType, since } });
  }
);

export default users;
