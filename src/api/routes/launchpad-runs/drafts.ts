import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../../types/hono.js";
import type { StoredRun } from "../../../launchpad/run-store.js";
import { STALE_PENDING_MS } from "../../../launchpad/run-store.js";
import { pendingPaths } from "../../../launchpad/pending.js";
import { RUN_SERVICES, definitionOf, parseRunSpec, quoteRun } from "../../../launchpad/services/index.js";
import { specError, type RunContext } from "./context.js";

const createBody = z.object({ service: z.enum(RUN_SERVICES), spec: z.unknown() });
const updateBody = z.object({ spec: z.unknown() });
const checkoutBody = z.union([
  z.object({ method: z.literal("credits") }),
  z.object({ method: z.literal("wallet"), intentId: z.string().min(1) }),
]);

export function createDraftRoutes(ctx: RunContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const quoteFor = (run: StoredRun) =>
    quoteRun(parseRunSpec(run.service, run.spec), { priceOf: ctx.priceOf, countProvisioned: ctx.store.countProvisioned });

  const sweepAbandoned = async (run: StoredRun): Promise<StoredRun> => {
    if (run.status !== "PAID" && run.status !== "RUNNING") return run;
    const paths = pendingPaths(run.progress);
    if (paths.length === 0) return run;
    const released = await ctx.store.sweepStale({
      id: run.id,
      apiCreditsId: run.apiCreditsId,
      paths,
      olderThanMs: STALE_PENDING_MS,
    });
    return released > 0 ? ((await ctx.store.get(run.id, run.apiCreditsId)) ?? run) : run;
  };

  const withoutCreditsId = <T extends { apiCreditsId: string }>(run: T): Omit<T, "apiCreditsId"> => {
    const { apiCreditsId: _internal, ...rest } = run;
    return rest;
  };

  const present = async (run: StoredRun) => withoutCreditsId(await presentWithQuote(run));

  const presentWithQuote = async (run: StoredRun) => {
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
      apiCreditsId: c.get("apiCredits").id,
      service: body.data.service,
      spec: body.data.spec,
    });
    return c.json({ data: await present(run) }, 201);
  });

  app.get("/", async (c) => {
    return c.json({ data: (await ctx.store.list(c.get("apiCredits").id)).map(withoutCreditsId) });
  });

  app.get("/:id", async (c) => {
    const found = await ctx.store.get(c.req.param("id"), c.get("apiCredits").id);
    if (!found) return c.json({ error: "Run not found" }, 404);
    return c.json({ data: await present(await sweepAbandoned(found)) });
  });

  app.patch("/:id", async (c) => {
    const apiCreditsId = c.get("apiCredits").id;
    const body = updateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "spec is required" }, 400);

    const existing = await ctx.store.get(c.req.param("id"), apiCreditsId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    if (existing.status !== "DRAFT") return c.json({ error: "A run can only change while it is a draft" }, 409);

    try {
      parseRunSpec(existing.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await ctx.store.updateDraft(existing.id, apiCreditsId, body.data.spec);
    if (!run) return c.json({ error: "A run can only change while it is a draft" }, 409);
    return c.json({ data: await present(run) });
  });

  app.post("/:id/cancel", async (c) => {
    const apiCreditsId = c.get("apiCredits").id;
    const found = await ctx.store.get(c.req.param("id"), apiCreditsId);
    if (!found) return c.json({ error: "Run not found" }, 404);
    const existing = await sweepAbandoned(found);

    if (existing.status === "DRAFT") {
      const run = await ctx.store.cancelDraft(existing.id, apiCreditsId);
      if (!run) return c.json({ error: "This run has already moved on" }, 409);
      return c.json({ data: withoutCreditsId(run) });
    }

    if (existing.status !== "PAID" && existing.status !== "RUNNING") {
      return c.json({ error: "This run is already closed" }, 409);
    }
    if (definitionOf(existing.service).inFlight(existing.progress)) {
      return c.json({ error: "A batch is still being confirmed. Try again once it lands." }, 409);
    }

    const closed = await ctx.store.complete({ id: existing.id, apiCreditsId, status: "CANCELLED", path: c.req.path });
    if (!closed) return c.json({ error: "This run is already closed" }, 409);
    return c.json({ data: { ...(await ctx.store.get(existing.id, apiCreditsId)), refunded: closed.refunded } });
  });

  app.post("/:id/checkout", async (c) => {
    const apiCreditsId = c.get("apiCredits").id;
    const body = checkoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose to pay with credits or from your wallet" }, 400);

    const existing = await ctx.store.get(c.req.param("id"), apiCreditsId);
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
      paymentId = (await ctx.intentPayment(body.data.intentId, apiCreditsId)) ?? undefined;
      if (!paymentId) {
        return c.json({ error: "That payment has not reached your account yet. Try again in a moment." }, 402);
      }
    }

    const outcome = await ctx.store.checkout({
      id: existing.id,
      apiCreditsId,
      service: existing.service,
      quote,
      paymentId,
      progress: definitionOf(existing.service).initialProgress(),
      path: c.req.path,
    });

    if (outcome === "not-draft") return c.json({ error: "This run is already paid" }, 409);
    if (outcome === "insufficient") {
      const balance = await ctx.store.balance(apiCreditsId);
      return c.json(
        { error: "Not enough credits for this run", data: { total: quote.total, balance, shortfall: quote.total - balance } },
        402,
      );
    }

    const run = await ctx.store.get(existing.id, apiCreditsId);
    return c.json({ data: run ? await present(run) : null });
  });

  return app;
}
