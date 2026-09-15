import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../../types/hono.js";
import type { StoredRun } from "../../../launchpad/run-store.js";
import { RUN_SERVICES, definitionOf, parseRunSpec, quoteRun } from "../../../launchpad/services/index.js";
import { specError, type RunContext } from "./context.js";

const createBody = z.object({ service: z.enum(RUN_SERVICES), spec: z.unknown() });
const updateBody = z.object({ spec: z.unknown() });
const checkoutBody = z.discriminatedUnion("method", [
  z.object({ method: z.literal("credits") }),
  z.object({ method: z.literal("wallet"), txHash: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }),
]);

export function createDraftRoutes(ctx: RunContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const quoteFor = (run: StoredRun) =>
    quoteRun(parseRunSpec(run.service, run.spec), { priceOf: ctx.priceOf, countProvisioned: ctx.store.countProvisioned });

  const present = async (run: StoredRun) => {
    if (run.status === "DRAFT") {
      try {
        return { ...run, quote: await quoteFor(run) };
      } catch {
        return { ...run, quote: null };
      }
    }
    if (run.status === "PAID" || run.status === "RUNNING") {
      const definition = definitionOf(run.service);
      if (definition.nextStep) {
        return { ...run, next: definition.nextStep(parseRunSpec(run.service, run.spec).spec, run.progress) };
      }
    }
    return run;
  };

  app.post("/", async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "service and spec are required" }, 400);
    try {
      parseRunSpec(body.data.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await ctx.store.create({
      apiClientId: c.get("apiClient").id,
      service: body.data.service,
      spec: body.data.spec,
    });
    return c.json({ data: await present(run) }, 201);
  });

  app.get("/", async (c) => {
    return c.json({ data: await ctx.store.list(c.get("apiClient").id) });
  });

  app.get("/:id", async (c) => {
    const run = await ctx.store.get(c.req.param("id"), c.get("apiClient").id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json({ data: await present(run) });
  });

  app.patch("/:id", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const body = updateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "spec is required" }, 400);

    const existing = await ctx.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    if (existing.status !== "DRAFT") return c.json({ error: "A run can only change while it is a draft" }, 409);

    try {
      parseRunSpec(existing.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await ctx.store.updateDraft(existing.id, apiClientId, body.data.spec);
    if (!run) return c.json({ error: "A run can only change while it is a draft" }, 409);
    return c.json({ data: await present(run) });
  });

  app.post("/:id/cancel", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const existing = await ctx.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);

    if (existing.status === "DRAFT") {
      const run = await ctx.store.cancelDraft(existing.id, apiClientId);
      if (!run) return c.json({ error: "This run has already moved on" }, 409);
      return c.json({ data: run });
    }

    if (existing.status !== "PAID" && existing.status !== "RUNNING") {
      return c.json({ error: "This run is already closed" }, 409);
    }
    if (definitionOf(existing.service).inFlight(existing.progress)) {
      return c.json({ error: "A batch is still being confirmed. Try again once it lands." }, 409);
    }

    const closed = await ctx.store.complete({ id: existing.id, apiClientId, status: "CANCELLED", path: c.req.path });
    if (!closed) return c.json({ error: "This run is already closed" }, 409);
    return c.json({ data: { ...(await ctx.store.get(existing.id, apiClientId)), refunded: closed.refunded } });
  });

  app.post("/:id/checkout", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const body = checkoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose to pay with credits or from your wallet" }, 400);

    const existing = await ctx.store.get(c.req.param("id"), apiClientId);
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
      const settled = await ctx.settleWalletPayment(body.data.txHash);
      paymentId = settled.payments.find((p) => p.apiClientId === apiClientId)?.paymentId;
      if (!paymentId) {
        return c.json({ error: "That payment has not reached your account yet. Try again in a moment." }, 402);
      }
    }

    const outcome = await ctx.store.checkout({
      id: existing.id,
      apiClientId,
      service: existing.service,
      quote,
      paymentId,
      progress: definitionOf(existing.service).initialProgress(),
      path: c.req.path,
    });

    if (outcome === "not-draft") return c.json({ error: "This run is already paid" }, 409);
    if (outcome === "insufficient") {
      const balance = await ctx.store.balance(apiClientId);
      return c.json(
        { error: "Not enough credits for this run", data: { total: quote.total, balance, shortfall: quote.total - balance } },
        402,
      );
    }

    const run = await ctx.store.get(existing.id, apiClientId);
    return c.json({ data: run ? await present(run) : null });
  });

  return app;
}
