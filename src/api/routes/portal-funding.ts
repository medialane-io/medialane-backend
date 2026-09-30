import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import { createIntent, settleIntent } from "../../funding/core.js";
import type { FundingMethod, FundingStore } from "../../funding/types.js";

export interface FundingRouteDeps {
  store: FundingStore;
  methods: FundingMethod[];
  mdlnMultiplier: (payer: string) => Promise<number>;
}

const createBody = z.object({ method: z.string().min(1), params: z.unknown() });

export function createFundingRoutes(deps: FundingRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const methodFor = (id: string) => deps.methods.find((m) => m.id === id && m.available());

  app.get("/methods", (c) =>
    c.json({ data: deps.methods.filter((m) => m.available()).map((m) => ({ id: m.id, ...m.describe() })) }),
  );

  app.post("/", async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose a payment method" }, 400);
    const method = methodFor(body.data.method);
    if (!method) return c.json({ error: "That payment method is not available" }, 404);

    const params = method.parseParams(body.data.params);
    if (!params.ok) return c.json({ error: params.error }, 400);

    const intent = await createIntent(deps.store, {
      apiClientId: c.get("apiClient").id,
      method: method.id,
      params: params.params,
    });
    return c.json({ data: { id: intent.id, method: intent.method, status: intent.status, expiresAt: intent.expiresAt } }, 201);
  });

  const load = async (c: Context<AppEnv>) => {
    const intent = await deps.store.get(c.req.param("id") ?? "", c.get("apiClient").id);
    const method = intent ? methodFor(intent.method) : undefined;
    return intent && method ? { intent, method } : null;
  };

  app.get("/:id", async (c) => {
    const found = await load(c);
    if (!found) return c.json({ error: "Top-up not found" }, 404);
    const { intent } = found;
    return c.json({ data: { id: intent.id, method: intent.method, status: intent.status, expiresAt: intent.expiresAt, payer: intent.payer } });
  });

  app.post("/:id/challenge", async (c) => {
    const found = await load(c);
    if (!found) return c.json({ error: "Top-up not found" }, 404);
    if (found.intent.status !== "PENDING" || found.intent.payer) return c.json({ error: "This top-up can no longer be authorized" }, 409);
    const result = found.method.challenge(found.intent, await c.req.json().catch(() => null));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ data: { typedData: result.typedData } });
  });

  app.post("/:id/authorize", async (c) => {
    const found = await load(c);
    if (!found) return c.json({ error: "Top-up not found" }, 404);
    if (found.intent.status !== "PENDING" || found.intent.payer) return c.json({ error: "This top-up can no longer be authorized" }, 409);

    const result = await found.method.authorize(found.intent, await c.req.json().catch(() => null));
    if (!result.ok) return c.json({ error: result.error }, 400);

    const stored = await deps.store.setPayer(found.intent.id, found.intent.apiClientId, result.payer, new Date());
    if (!stored) return c.json({ error: "This top-up can no longer be authorized" }, 409);
    return c.json({ data: { instructions: result.instructions } });
  });

  app.post("/:id/submit", async (c) => {
    const found = await load(c);
    if (!found) return c.json({ error: "Top-up not found" }, 404);
    const { intent, method } = found;
    if (intent.status === "SETTLED") return c.json({ data: { status: "SETTLED" } });
    if (intent.status !== "PENDING") return c.json({ error: "This top-up is already closed" }, 409);
    if (!intent.payer) return c.json({ error: "Choose and sign with your wallet first" }, 409);

    const verified = await method.verify(intent, await c.req.json().catch(() => null));
    if (!verified.ok) return c.json({ data: { status: "PENDING", reason: verified.reason } }, 202);

    const settled = await settleIntent({ store: deps.store, mdlnMultiplier: deps.mdlnMultiplier }, intent, verified.payment);
    if (!settled.ok) return c.json({ error: "That transfer was already counted" }, 409);
    return c.json({ data: { status: "SETTLED", credited: settled.credited } });
  });

  app.post("/:id/cancel", async (c) => {
    const found = await load(c);
    if (!found) return c.json({ error: "Top-up not found" }, 404);
    const { intent } = found;
    if (intent.status === "SETTLED") return c.json({ error: "This top-up is already paid" }, 409);
    if (intent.status !== "PENDING") return c.json({ data: { status: intent.status } });

    if (await deps.store.cancel(intent.id, intent.apiClientId)) return c.json({ data: { status: "EXPIRED" } });

    // Someone else closed it first. Report what it is now; a settlement that won the race is a conflict.
    const now = await deps.store.get(intent.id, intent.apiClientId);
    if (now?.status === "SETTLED") return c.json({ error: "This top-up is already paid" }, 409);
    return c.json({ data: { status: now?.status ?? "EXPIRED" } });
  });

  return app;
}
