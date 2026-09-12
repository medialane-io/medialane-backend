import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { portalSubject } from "../middleware/portalSubject.js";
import { quoteRun, MAX_RECIPIENTS_PER_RUN } from "../../payments/launchpad.js";
import { parseDepositEvents } from "../../mirror/handlers/treasuryDeposit.js";
import { x402Config } from "../../config/x402.js";
import { callRpc, normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("routes:business-launchpad");
const launchpad = new Hono<AppEnv>();

launchpad.use("*", portalSubject);

const quoteSchema = z.object({
  service: z.string().min(1),
  recipients: z.number().int().positive().max(MAX_RECIPIENTS_PER_RUN),
});

const runSchema = quoteSchema.extend({
  txHash: z.string().min(3),
});

export type ReceiptFetcher = (hash: string) => Promise<{ events?: RawStarknetEvent[] }>;

async function fetchReceipt(hash: string): Promise<{ events?: RawStarknetEvent[] }> {
  return callRpc((provider) =>
    (provider as { getTransactionReceipt: (h: string) => Promise<{ events?: RawStarknetEvent[] }> })
      .getTransactionReceipt(hash),
  );
}

launchpad.post("/quote", async (c) => {
  const parsed = quoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const quote = await quoteRun(parsed.data.service, parsed.data.recipients);
  return c.json({
    data: {
      ...quote,
      asset: x402Config.usdcContract,
      payTo: x402Config.treasury,
    },
  });
});

export function registerRunRoute(app: Hono<AppEnv>, receipt: ReceiptFetcher = fetchReceipt) {
  app.post("/runs", async (c) => {
    const payer = c.get("walletAddress");
    if (!payer) return c.json({ error: "Sign in to start a run" }, 401);
    if (!x402Config.treasury) return c.json({ error: "Payments are not configured" }, 503);

    const parsed = runSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

    const { service, recipients, txHash } = parsed.data;
    const hash = normalizeHash(txHash);
    const quote = await quoteRun(service, recipients);
    const owed = BigInt(quote.totalAtomic);

    const already = await prisma.launchpadRun.findUnique({ where: { txHash: hash } });
    if (already) return c.json({ error: "That payment already started a run" }, 409);

    let events: RawStarknetEvent[];
    try {
      events = (await receipt(hash)).events ?? [];
    } catch (err) {
      log.warn({ err, hash }, "could not read the payment transaction");
      return c.json({ error: "That payment is not on chain yet" }, 409);
    }

    const usdc = normalizeAddress("STARKNET", x402Config.usdcContract);
    const paid = parseDepositEvents(events, x402Config.treasury)
      .filter((d) => d.payer === payer && d.token === usdc)
      .reduce((sum, d) => sum + d.amountAtomic, 0n);

    if (paid < owed) {
      return c.json(
        { error: "That payment does not cover this run", owed: owed.toString(), paid: paid.toString() },
        402,
      );
    }

    const run = await prisma.launchpadRun.create({
      data: {
        apiClientId: c.get("apiClient").id,
        payer,
        service,
        recipients,
        quotedAtomic: owed.toString(),
        paidAtomic: paid.toString(),
        txHash: hash,
      },
      select: { id: true, createdAt: true },
    });

    log.info({ run: run.id, payer, service, recipients }, "launchpad run paid for");
    return c.json({ data: run }, 201);
  });
  return app;
}

registerRunRoute(launchpad);

export default launchpad;
