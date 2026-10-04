import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { accountWallet, ensureAccountForWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";
import { Chain } from "@prisma/client";
import { callerClientId } from "../../utils/caller.js";
import { IDENTITY_SCHEME, emailValues, normalizeIdentityValue } from "../../utils/identity.js";
import { appNameForClient } from "../../apps/resolve.js";
import { currentAccountIdFromSession } from "../../utils/accountSession.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";
import { getCurrentEmailIdentity, canClaimEmail } from "../../utils/emailVerification.js";
import { issueVerificationCode } from "./auth-email.js";
import { createLogger } from "../../utils/logger.js";
import { emailDeadlineFor } from "../../utils/emailDeadline.js";
import { needsAttention, welcomeAccount } from "../../notices/sweep.js";
import { productionSweepDeps } from "../../notices/prismaDeps.js";
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


  accountToken: z.string().optional(),
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
    const clientId = callerClientId(c);
    if (!clientId) return c.json(NO_CLIENT, 400);
    const chain: Chain = body.chain ?? "STARKNET";

    const { accountId } = await ensureAccountForWallet({
      chain,
      address: body.walletAddress,
      provider,
      clientId,
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
  const clientId = callerClientId(c);
  if (!clientId) return c.json(NO_CLIENT, 400);
  const chain: Chain = parsed.data.chain ?? "STARKNET";

  if (chain !== "STARKNET") {
    return c.json({
      error: "Only STARKNET is supported on /v1/users/me in v1 — cross-chain registration arrives with SIWE/SIWB",
    }, 400);
  }

  const linkToAccountId = parsed.data.accountToken
    ? ((await currentAccountIdFromSession(parsed.data.accountToken)) ?? undefined)
    : undefined;

  const { accountId } = await ensureAccountForWallet({
    chain,
    address: walletAddress,
    provider,
    clientId: clientId,
    linkToAccountId,
  });

  if (parsed.data.email) {
    const existing = await prisma.identity.findFirst({
      where: {
        clientId,
        scheme: IDENTITY_SCHEME.EMAIL,
        value: { in: emailValues(parsed.data.email) },
      },
      select: { id: true },
    });
    if (!existing) {
      await prisma.identity.create({
        data: {
          accountId,
          app: await appNameForClient(clientId),
          scheme: IDENTITY_SCHEME.EMAIL,
          value: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, parsed.data.email),
          email: parsed.data.email,
          clientId: clientId,
          verifiedAt: null,
        },
      });
      issueVerificationCode(parsed.data.email, clientId).catch((err: unknown) => {
        log.error({ err, email: parsed.data.email }, "Failed to auto-send verification code");
      });
    }

  }

  welcomeAccount(productionSweepDeps(), accountId)
    .then((result) => {
      if (needsAttention(result)) log.warn({ accountId, ...result }, "The welcome email was due but not sent");
    })
    .catch((err: unknown) => {
      log.error({ err, accountId }, "Failed to send the welcome email");
    });

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
    where: { clientId_chain_address: { clientId: callerClientId(c) ?? "", chain: "STARKNET", address: walletAddress } },
    select: { accountId: true },
  });
  if (!existing) return c.json({ error: "Account not found" }, 404);

  const newAddress = normalizeAddress(newWalletId.chain, newWalletId.address);
  const clientId = callerClientId(c);
  if (!clientId) return c.json(NO_CLIENT, 400);

  await prisma.$transaction([
    prisma.identity.updateMany({
      where: { accountId: existing.accountId, scheme: IDENTITY_SCHEME.WALLET },
      data: { isPrimary: false },
    }),
    prisma.identity.create({
      data: {
        accountId: existing.accountId,
        app: await appNameForClient(clientId),
        scheme: IDENTITY_SCHEME.WALLET,
        provider: "unknown",
        chain: newWalletId.chain,
        address: newAddress,
        clientId: clientId,
        isPrimary: true,
      },
    }),
  ]);

  return c.json({ walletAddress: newAddress });
});

const accountWalletSchema = z.object({ accountToken: z.string().min(1) });

users.post("/me/wallet", zValidator("json", accountWalletSchema), async (c) => {
  const { accountToken } = c.req.valid("json");
  const accountId = await currentAccountIdFromSession(accountToken);
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
  accountToken: z.string().min(1),
  newOwnerPubkey: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
});

users.post("/me/wallet/key", zValidator("json", walletKeySchema), async (c) => {
  const { accountToken, newOwnerPubkey } = c.req.valid("json");
  const accountId = await currentAccountIdFromSession(accountToken);
  if (!accountId) return c.json({ error: "Invalid or expired session" }, 401);
  const outcome = await setupWalletKey(productionWalletKeyDeps, accountId, newOwnerPubkey);
  if (outcome.status !== 200) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ walletAddress: outcome.walletAddress, removeOwnerGuid: outcome.removeOwnerGuid });
});

users.get("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const identity = await prisma.identity.findUnique({
    where: { clientId_chain_address: { clientId: callerClientId(c) ?? "", chain: "STARKNET", address: walletAddress } },
    select: { address: true, accountId: true, account: { select: { publicId: true, status: true, createdAt: true } } },
  });
  if (!identity) return c.json({ error: "User not found" }, 404);
  const emailIdentity = await getCurrentEmailIdentity(identity.accountId);
  const emailDeadline = emailDeadlineFor({
    status: identity.account.status,
    createdAt: identity.account.createdAt,
    hasEmail: emailIdentity !== null,
    emailVerified: emailIdentity ? emailIdentity.verifiedAt !== null : false,
  });
  return c.json({
    walletAddress: identity.address,
    accountId: identity.accountId,
    publicId: identity.account.publicId,
    email: emailIdentity?.email ?? null,
    emailVerified: emailIdentity ? emailIdentity.verifiedAt !== null : false,
    emailDeadline: emailDeadline?.toISOString() ?? null,
  });
});

const NO_CLIENT = {
  error: "unknown_client",
  message: "This API key has no client, so an account cannot be resolved for it.",
} as const;

const changeEmailSchema = z.object({ email: z.string().email() });

users.post("/me/email", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = changeEmailSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const email = parsed.data.email;
  const clientId = callerClientId(c);
  if (!clientId) return c.json(NO_CLIENT, 400);

  const identity = await prisma.identity.findUnique({
    where: { clientId_chain_address: { clientId: callerClientId(c) ?? "", chain: "STARKNET", address: walletAddress } },
    select: { accountId: true },
  });
  if (!identity) return c.json({ error: "User not found" }, 404);
  const accountId = identity.accountId;

  const existingOwner = await prisma.identity.findFirst({
    where: { clientId, scheme: IDENTITY_SCHEME.EMAIL, value: { in: emailValues(email) } },
    select: { accountId: true, verifiedAt: true },
  });
  const decision = canClaimEmail(accountId, existingOwner);
  if (!decision.allowed) {
    const message = decision.reason === "already-yours"
      ? "That's already your current email."
      : "That email is already in use on another account.";
    return c.json({ error: message }, 409);
  }

  await prisma.$transaction([
    prisma.identity.deleteMany({ where: { accountId, scheme: IDENTITY_SCHEME.EMAIL, clientId: clientId } }),
    prisma.identity.deleteMany({ where: { scheme: IDENTITY_SCHEME.EMAIL, value: { in: emailValues(email) }, clientId: clientId } }),
    prisma.identity.create({
      data: {
        accountId,
        app: await appNameForClient(clientId),
        scheme: IDENTITY_SCHEME.EMAIL,
        value: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email),
        email,
        clientId: clientId,
        verifiedAt: null,
      },
    }),
  ]);

  await issueVerificationCode(email, clientId);

  return c.json({ email, emailVerified: false });
});

users.get(
  "/count",
  async (c) => {
    const { chain, clientId, walletType, since } = c.req.query();

    const identityWhere: Record<string, unknown> = {};
    if (chain && VALID_CHAINS.has(chain as Chain)) identityWhere.chain = chain;
    if (walletType) identityWhere.provider = walletType.toLowerCase();
    if (clientId) identityWhere.clientId = clientId;

    const accountWhere: Record<string, unknown> = {};
    if (Object.keys(identityWhere).length > 0) accountWhere.identities = { some: identityWhere };
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) accountWhere.createdAt = { gte: sinceDate };
    }

    const count = await prisma.account.count({ where: accountWhere });
    return c.json({ count, filters: { chain, clientId, walletType, since } });
  }
);

export default users;
