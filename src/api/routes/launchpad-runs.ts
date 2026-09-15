import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import { parseRunSpec, RUN_SERVICES } from "../../launchpad/run-spec.js";
import { quoteRun, type QuoteDeps } from "../../launchpad/quote.js";
import { prismaRunStore, type RunStore, type StoredRun } from "../../launchpad/run-store.js";
import { creditFromTransaction } from "../../mirror/handlers/treasuryDeposit.js";

export interface RunRouteDeps {
  store: RunStore;
  priceOf?: QuoteDeps["priceOf"];
  settleWalletPayment?: (txHash: string) => Promise<unknown>;
}

const createBody = z.object({ service: z.enum(RUN_SERVICES), spec: z.unknown() });
const updateBody = z.object({ spec: z.unknown() });
const checkoutBody = z.discriminatedUnion("method", [
  z.object({ method: z.literal("credits") }),
  z.object({ method: z.literal("wallet"), txHash: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }),
]);

function specError(err: unknown) {
  if (err instanceof z.ZodError) {
    return { error: "The run is not complete", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  return { error: "The run is not complete" };
}

export function createRunRoutes(deps: RunRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const settleWalletPayment = deps.settleWalletPayment ?? creditFromTransaction;

  const quoteFor = async (run: StoredRun) =>
    quoteRun(parseRunSpec(run.service, run.spec), {
      priceOf: deps.priceOf,
      countProvisioned: deps.store.countProvisioned,
    });

  const withQuote = async (run: StoredRun) => {
    if (run.status !== "DRAFT") return run;
    try {
      return { ...run, quote: await quoteFor(run) };
    } catch {
      return { ...run, quote: null };
    }
  };

  app.post("/", async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "service and spec are required" }, 400);
    try {
      parseRunSpec(body.data.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await deps.store.create({
      apiClientId: c.get("apiClient").id,
      service: body.data.service,
      spec: body.data.spec,
    });
    return c.json({ data: await withQuote(run) }, 201);
  });

  app.get("/", async (c) => {
    const runs = await deps.store.list(c.get("apiClient").id);
    return c.json({ data: runs });
  });

  app.get("/:id", async (c) => {
    const run = await deps.store.get(c.req.param("id"), c.get("apiClient").id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json({ data: await withQuote(run) });
  });

  app.patch("/:id", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const body = updateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "spec is required" }, 400);

    const existing = await deps.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    if (existing.status !== "DRAFT") return c.json({ error: "A run can only change while it is a draft" }, 409);

    try {
      parseRunSpec(existing.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await deps.store.updateDraft(existing.id, apiClientId, body.data.spec);
    if (!run) return c.json({ error: "A run can only change while it is a draft" }, 409);
    return c.json({ data: await withQuote(run) });
  });

  app.post("/:id/cancel", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const existing = await deps.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    const run = await deps.store.cancelDraft(existing.id, apiClientId);
    if (!run) return c.json({ error: "Only a draft can be cancelled here" }, 409);
    return c.json({ data: run });
  });

  app.post("/:id/checkout", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const body = checkoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose to pay with credits or from your wallet" }, 400);

    const existing = await deps.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    if (existing.status !== "DRAFT") return c.json({ error: "This run is already paid" }, 409);

    let quote;
    try {
      quote = await quoteFor(existing);
    } catch (err) {
      return c.json(specError(err), 400);
    }

    let paymentId: string | undefined;
    if (body.data.method === "wallet") {
      await settleWalletPayment(body.data.txHash);
      const found = await deps.store.findPayment(body.data.txHash, apiClientId);
      if (!found) {
        return c.json({ error: "That payment has not reached your account yet. Try again in a moment." }, 402);
      }
      paymentId = found;
    }

    const outcome = await deps.store.checkout({
      id: existing.id,
      apiClientId,
      service: existing.service,
      quote,
      paymentId,
      path: c.req.path,
    });

    if (outcome === "not-draft") return c.json({ error: "This run is already paid" }, 409);
    if (outcome === "insufficient") {
      const balance = await deps.store.balance(apiClientId);
      return c.json(
        { error: "Not enough credits for this run", data: { total: quote.total, balance, shortfall: quote.total - balance } },
        402,
      );
    }

    const run = await deps.store.get(existing.id, apiClientId);
    return c.json({ data: run });
  });

  return app;
}

export const launchpadRuns = createRunRoutes({ store: prismaRunStore });
