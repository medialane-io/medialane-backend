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
import { verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";
import { getCurrentEmailIdentity, isEmailVerificationRequired } from "../../utils/emailVerification.js";
import { issueVerificationCode } from "./auth-email.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:users");

const users = new Hono<AppEnv>();

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

  chain: chainEnum.optional(),

  email: z.string().email().optional(),

  emailVerificationToken: z.string().optional(),

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

  if (chain !== "STARKNET") {
    return c.json({
      error: "Only STARKNET is supported on /v1/users/me in v1 — cross-chain registration arrives with SIWE/SIWB",
    }, 400);
  }

  const linkToAccountId = parsed.data.accountToken
    ? (verifyAccountSessionToken(parsed.data.accountToken) ?? undefined)
    : undefined;

  const { accountId } = await ensureAccountForWallet({
    chain,
    address: walletAddress,
    provider,
    appSource,
    linkToAccountId,
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
      issueVerificationCode(parsed.data.email).catch((err: unknown) => {
        log.error({ err, email: parsed.data.email }, "Failed to auto-send verification code");
      });
    }

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
    where: { chain_address: { chain: "STARKNET", address: walletAddress } },
    select: { accountId: true },
  });
  if (!existing) return c.json({ error: "Account not found" }, 404);

  const newAddress = normalizeAddress(newWalletId.chain, newWalletId.address);

  await prisma.$transaction([
    prisma.identity.updateMany({
      where: { accountId: existing.accountId, scheme: IDENTITY_SCHEME.WALLET },
      data: { isPrimary: false },
    }),
    prisma.identity.create({
      data: {
        accountId: existing.accountId,
        scheme: IDENTITY_SCHEME.WALLET,
        provider: "unknown",
        chain: newWalletId.chain,
        address: newAddress,
        appSource: "MEDIALANE_IO",
        isPrimary: true,
      },
    }),
  ]);

  return c.json({ walletAddress: newAddress });
});

users.get("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const identity = await prisma.identity.findUnique({
    where: { chain_address: { chain: "STARKNET", address: walletAddress } },
    select: { address: true, accountId: true, account: { select: { publicId: true } } },
  });
  if (!identity) return c.json({ error: "User not found" }, 404);
  const emailIdentity = await getCurrentEmailIdentity(identity.accountId);
  return c.json({
    walletAddress: identity.address,
    accountId: identity.accountId,
    publicId: identity.account.publicId,
    email: emailIdentity?.email ?? null,
    emailVerified: emailIdentity ? emailIdentity.verifiedAt !== null : false,
    requiresEmailVerification: isEmailVerificationRequired(emailIdentity),
  });
});

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
