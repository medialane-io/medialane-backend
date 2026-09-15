import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import { parseRunSpec, RUN_SERVICES } from "../../launchpad/run-spec.js";
import { quoteRun, type QuoteDeps } from "../../launchpad/quote.js";
import { prismaRunStore, type RunStore, type StoredRun } from "../../launchpad/run-store.js";

export interface RunRouteDeps {
  store: RunStore;
  priceOf?: QuoteDeps["priceOf"];
}

const createBody = z.object({ service: z.enum(RUN_SERVICES), spec: z.unknown() });
const updateBody = z.object({ spec: z.unknown() });

function specError(err: unknown) {
  if (err instanceof z.ZodError) {
    return { error: "The run is not complete", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  return { error: "The run is not complete" };
}

export function createRunRoutes(deps: RunRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const withQuote = async (run: StoredRun) => {
    if (run.status !== "DRAFT") return run;
    try {
      const parsed = parseRunSpec(run.service, run.spec);
      const quote = await quoteRun(parsed, { priceOf: deps.priceOf, countProvisioned: deps.store.countProvisioned });
      return { ...run, quote };
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

  return app;
}

export const launchpadRuns = createRunRoutes({ store: prismaRunStore });
