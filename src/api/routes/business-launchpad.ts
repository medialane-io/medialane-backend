import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import { portalSubject } from "../middleware/portalSubject.js";
import { quoteRun, MAX_RECIPIENTS_PER_RUN } from "../../payments/launchpad.js";
import { debitCredits } from "../../payments/credits.js";
import { recordUsage } from "../../payments/usage.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:business-launchpad");
const launchpad = new Hono<AppEnv>();

launchpad.use("*", portalSubject);

const runSchema = z.object({
  service: z.string().min(1),
  recipients: z.number().int().positive().max(MAX_RECIPIENTS_PER_RUN),
});

launchpad.post("/quote", async (c) => {
  const parsed = runSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  return c.json({ data: await quoteRun(parsed.data.service, parsed.data.recipients) });
});

launchpad.post("/runs", async (c) => {
  if (!c.get("walletAddress")) return c.json({ error: "Sign in to start a run" }, 401);

  const parsed = runSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const { service, recipients } = parsed.data;
  const apiClient = c.get("apiClient");
  const quote = await quoteRun(service, recipients);

  const paid = await debitCredits(apiClient.id, quote.totalCredits);
  if (!paid) {
    return c.json(
      {
        error: "not_enough_credits",
        owed: quote.totalCredits,
        balance: apiClient.creditBalance,
        short: Math.max(0, quote.totalCredits - apiClient.creditBalance),
      },
      402,
    );
  }

  for (const item of quote.lines) {
    await recordUsage({
      apiClientId: apiClient.id,
      actionKey: item.actionKey,
      chain: "STARKNET",
      service,
      unitCredits: item.unitCredits,
      units: item.units,
      credits: item.credits,
      method: "POST",
      path: "/v1/business/launchpad/runs",
      status: 201,
    }).catch((err) => log.error({ err, apiClient: apiClient.id }, "usage record failed"));
  }

  log.info({ apiClient: apiClient.id, service, recipients, credits: quote.totalCredits }, "run charged");
  return c.json({ data: { charged: quote.totalCredits, lines: quote.lines } }, 201);
});

export default launchpad;
