import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "crypto";
import type { AppVariables } from "../../types/hono.js";
import { portalSubject } from "../middleware/portalSubject.js";
import { launchpadRuns } from "./launchpad-runs/index.js";
import prisma from "../../db/client.js";
import { confirmKeyChange, productionKeyConfirmationDeps } from "../../portal/apiKeyConfirmation.js";
import { creditFromTransaction } from "../../mirror/handlers/treasuryDeposit.js";
import { deleteApiKey, generateApiKey, replaceApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";
import { isPrivateOrInsecureUrl } from "../../utils/ssrf.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";
import { createFundingRoutes } from "./portal-funding.js";
import { prismaFundingStore } from "../../funding/store.js";
import { productionFundingMethods } from "../../funding/registry.js";
import { mdlnMultiplier } from "../../payments/mdln.js";
import { validated } from "../http/validate.js";

const log = createLogger("routes:portal");
const portal = new Hono<{ Variables: AppVariables }>();
const starknetScheme = new StarknetUsdcScheme();

portal.use("*", portalSubject);

portal.route("/runs", launchpadRuns);
portal.route(
  "/funding",
  createFundingRoutes({ store: prismaFundingStore, methods: productionFundingMethods(), mdlnMultiplier }),
);

portal.get("/me", async (c) => {
  const account = c.get("account");
  const apiCredits = c.get("apiCredits");
  return c.json({
    data: {
      id: apiCredits.id,
      accountId: apiCredits.accountId,
      status: account.status,
      creditBalance: apiCredits.creditBalance,
    },
  });
});

const creditsCheckBody = z.object({ txHash: z.string().min(3) });

portal.post("/credits/check", validated("json", creditsCheckBody, { message: "txHash is required" }), async (c) => {
  const parsed = c.req.valid("json");

  try {
    const { credited } = await creditFromTransaction(parsed.txHash);
    return c.json({ data: { deposits: credited } });
  } catch {
    return c.json({ data: { deposits: 0 } });
  }
});

portal.get("/credits/history", async (c) => {
  const apiCredits = c.get("apiCredits");
  const payments = await prisma.payment.findMany({
    where: { apiCreditsId: apiCredits.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      asset: true,
      amountAtomic: true,
      creditedAmount: true,
      mdlnMultiplier: true,
      txHash: true,
      status: true,
      createdAt: true,
    },
  });
  return c.json({ data: payments });
});

portal.get("/keys", async (c) => {
  const apiCredits = c.get("apiCredits");

  const keys = await prisma.apiKey.findMany({
    where: { apiCreditsId: apiCredits.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      prefix: true,
      label: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  return c.json({ data: keys });
});

const createKeySchema = z.object({
  label: z.string().max(64).optional(),
  confirmation: z.unknown(),
});

const CONFIRMATION_REQUIRED = {
  error: "confirmation_required",
  message: "Approve this change with your wallet.",
} as const;

portal.post("/keys", validated("json", createKeySchema), async (c) => {
  const apiCredits = c.get("apiCredits");
  const parsed = c.req.valid("json");

  const current = (await prisma.apiKey.findFirst({ where: { apiCreditsId: apiCredits.id }, select: { id: true } }))?.id ?? null;
  const change = { action: "replace_api_key", key: current ?? "none" } as const;
  if (!(await confirmKeyChange(productionKeyConfirmationDeps, apiCredits.accountId, change, parsed.confirmation))) {
    return c.json(CONFIRMATION_REQUIRED, 403);
  }

  const generated = generateApiKey();
  const key = await replaceApiKey(apiCredits, current, generated, parsed.label);
  if (!key) return c.json(CONFIRMATION_REQUIRED, 403);

  log.info({ keyId: key.id, apiCreditsId: apiCredits.id }, "API key created, replacing any earlier key");
  return c.json({ data: { id: key.id, prefix: key.prefix, label: key.label, plaintext: generated.plaintext } }, 201);
});

portal.delete("/keys/:id", async (c) => {
  const apiCredits = c.get("apiCredits");
  const { id } = c.req.param();
  const body = (await c.req.json().catch(() => ({}))) as { confirmation?: unknown };
  const change = { action: "delete_api_key", key: id } as const;
  if (!(await confirmKeyChange(productionKeyConfirmationDeps, apiCredits.accountId, change, body?.confirmation))) {
    return c.json(CONFIRMATION_REQUIRED, 403);
  }

  if (!(await deleteApiKey(apiCredits, id))) return c.json({ error: "API key not found" }, 404);
  log.info({ keyId: id, apiCreditsId: apiCredits.id }, "API key removed via portal");
  return c.json({ data: { id } });
});

export default portal;
