import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../../types/hono.js";
import { createLogger } from "../../../utils/logger.js";
import type { StoredRun } from "../../../launchpad/run-store.js";
import type { StepState } from "../../../launchpad/services/data-tokenization/progress.js";
import type { Call } from "../../../launchpad/services/ip-ticketing/chain.js";
import { buildSponsoredInvoke } from "../paymaster.js";
import { executeBody, indexParam, ownsWallet, walletBody, type RunContext, type RunReceipt } from "./context.js";
import { confirmStep, executeStep } from "./sponsored-step.js";

const log = createLogger("routes:launchpad-runs:steps");

const fileNameBody = z.object({ name: z.string().min(1).max(255) });
const uploadedBody = z.object({ name: z.string().min(1).max(255), cid: z.string().min(10).max(120) });

export class NotReady extends Error {}

export interface ActiveBase {
  run: StoredRun;
  apiClientId: string;
}

export interface SponsoredStep<A> {
  route: string;
  label: string;
  path(index: number): string[];
  credits(active: A, index: number): Promise<number>;
  open(active: A, index: number): boolean;
  calls(active: A, index: number, owner: string): Promise<Call[]>;
  state(active: A, index: number): StepState | undefined;
  succeeded(active: A, index: number, receipt: RunReceipt, txHash: string, c: Context<AppEnv>): Promise<Response>;
}

export interface RunFiles<A> {
  expected(active: A, name: string): { size: number; type: string } | null;
  uri(active: A, name: string): string | null;
  path(name: string): string[];
  credits(): Promise<number>;
}

export interface StepTools<A> {
  ctx: RunContext;
  loadActive(c: Context<AppEnv>): Promise<A | Response>;
  record(active: ActiveBase, path: string[], value: unknown): Promise<void>;
  notReady(c: Context<AppEnv>, err: unknown): Response;
}

export interface RunServiceSteps<A extends ActiveBase> {
  service: string;
  load(run: StoredRun): A;
  sponsored: SponsoredStep<A>[];
  files: RunFiles<A>;
  extra?(app: Hono<AppEnv>, tools: StepTools<A>): void;
}

type AnyService = RunServiceSteps<any>;

const indexed = (route: string) => route.includes(":index");

const EXTRA_ROUTE_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function guardAgainstRouteCollisions(app: Hono<AppEnv>, service: AnyService, claimed: Map<string, string>): Hono<AppEnv> {
  const guarded = Object.create(app) as Hono<AppEnv>;
  for (const method of EXTRA_ROUTE_METHODS) {
    (guarded as unknown as Record<string, unknown>)[method] = (path: string, ...rest: unknown[]) => {
      const key = `${method.toUpperCase()} ${path}`;
      const owner = claimed.get(key);
      if (owner && owner !== service.service) {
        throw new Error(
          `Route collision: "${service.service}" and "${owner}" both register ${key} on the shared launchpad-run app. ` +
            `Give one of them its own path — see ip-ticketing vs certificate-emission for the convention.`,
        );
      }
      claimed.set(key, service.service);
      return (app as unknown as Record<string, (...args: unknown[]) => unknown>)[method](path, ...rest);
    };
  }
  return guarded;
}

export function createRunStepRoutes(ctx: RunContext, services: AnyService[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const ex = () => ctx.execution();

  const notReady = (c: Context<AppEnv>, err: unknown) => {
    log.warn({ err }, "run step not ready");
    return c.json({ error: "This step is not ready" }, 409);
  };

  const record = (active: ActiveBase, path: string[], value: unknown) =>
    ctx.store.record(active.run.id, active.apiClientId, path, value);

  const loadAny = async (c: Context<AppEnv>): Promise<{ service: AnyService; active: ActiveBase } | Response> => {
    const apiClientId = c.get("apiClient").id;
    const run = await ctx.store.get(c.req.param("id") ?? "", apiClientId);
    if (!run) return c.json({ error: "Run not found" }, 404);
    if (run.status !== "PAID" && run.status !== "RUNNING") {
      return c.json({ error: "This run is not ready to execute" }, 409);
    }
    const service = services.find((s) => s.service === run.service);
    if (!service) return c.json({ error: "This run does not use this step" }, 400);
    return { service, active: service.load(run) };
  };

  const claimedExtraRoutes = new Map<string, string>();
  for (const service of services) {
    service.extra?.(guardAgainstRouteCollisions(app, service, claimedExtraRoutes), {
      ctx,
      record,
      notReady,
      loadActive: async (c) => {
        const loaded = await loadAny(c);
        if (loaded instanceof Response) return loaded;
        if (loaded.service !== service) return c.json({ error: "This run does not use this step" }, 400);
        return loaded.active;
      },
    });
  }

  const routes = [...new Set(services.flatMap((s) => s.sponsored.map((step) => step.route)))];

  const stepOf = (c: Context<AppEnv>, route: string, loaded: { service: AnyService; active: ActiveBase }) => {
    const step = (loaded.service.sponsored as SponsoredStep<ActiveBase>[]).find((s) => s.route === route);
    if (!step) return c.json({ error: "This run does not use this step" }, 400);
    const index = indexed(route) ? indexParam(c) : 0;
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);
    return { step, index };
  };

  const prepare = async (
    c: Context<AppEnv>,
    step: SponsoredStep<ActiveBase>,
    active: ActiveBase,
    index: number,
    owner: string,
  ): Promise<Call[] | Response> => {
    try {
      return await step.calls(active, index, owner);
    } catch (err) {
      if (err instanceof NotReady) return notReady(c, err);
      log.warn({ err, run: active.run.id }, "run step could not be prepared");
      return c.json({ error: `Could not prepare ${step.label.toLowerCase()}. Try again.` }, 502);
    }
  };

  for (const route of routes) {
    app.post(`/${route}/build`, async (c) => {
      const loaded = await loadAny(c);
      if (loaded instanceof Response) return loaded;
      const found = stepOf(c, route, loaded);
      if (found instanceof Response) return found;
      const { step, index } = found;

      const body = walletBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "userAddress is required" }, 400);
      if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
      if (!step.open(loaded.active, index)) return c.json({ error: `${step.label} is already on its way` }, 409);

      const calls = await prepare(c, step, loaded.active, index, body.data.userAddress);
      if (calls instanceof Response) return calls;
      const outcome = await buildSponsoredInvoke(ex().sponsored, { userAddress: body.data.userAddress, calls });
      return c.json(outcome.body, outcome.status);
    });

    app.post(`/${route}/execute`, async (c) => {
      const loaded = await loadAny(c);
      if (loaded instanceof Response) return loaded;
      const found = stepOf(c, route, loaded);
      if (found instanceof Response) return found;
      const { step, index } = found;

      const body = executeBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "userAddress, typedData and signature are required" }, 400);
      if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
      if (!step.open(loaded.active, index)) return c.json({ error: `${step.label} is already on its way` }, 409);

      const calls = await prepare(c, step, loaded.active, index, body.data.userAddress);
      if (calls instanceof Response) return calls;

      return executeStep(ctx, c, {
        runId: loaded.active.run.id,
        apiClientId: loaded.active.apiClientId,
        path: step.path(index),
        credits: await step.credits(loaded.active, index),
        label: step.label,
        calls,
        ...body.data,
      });
    });

    app.post(`/${route}/confirm`, async (c) => {
      const loaded = await loadAny(c);
      if (loaded instanceof Response) return loaded;
      const found = stepOf(c, route, loaded);
      if (found instanceof Response) return found;
      const { step, index } = found;

      return confirmStep(ctx, c, {
        runId: loaded.active.run.id,
        apiClientId: loaded.active.apiClientId,
        path: step.path(index),
        credits: await step.credits(loaded.active, index),
        label: step.label,
        state: step.state(loaded.active, index),
        extra: indexed(route) ? { index } : undefined,
        onSucceeded: (receipt, txHash) => step.succeeded(loaded.active, index, receipt, txHash, c),
      });
    });
  }

  app.post("/files/upload-url", async (c) => {
    const loaded = await loadAny(c);
    if (loaded instanceof Response) return loaded;
    const { service, active } = loaded;

    const body = fileNameBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name is required" }, 400);
    const { name } = body.data;
    const expected = service.files.expected(active, name);
    if (!expected) return c.json({ error: `${name} is not part of this run` }, 400);
    if (service.files.uri(active, name)) return c.json({ error: `${name} is already uploaded` }, 409);

    try {
      const url = await ex().signedUpload({
        name,
        size: expected.size,
        type: expected.type,
        keyvalues: { run: active.run.id, file: name },
      });
      return c.json({ data: { name, url } }, 201);
    } catch (err) {
      log.warn({ err, run: active.run.id, file: name }, "run signed upload failed");
      return c.json({ error: "Could not prepare this upload. Try again." }, 502);
    }
  });

  app.post("/files/uploaded", async (c) => {
    const loaded = await loadAny(c);
    if (loaded instanceof Response) return loaded;
    const { service, active } = loaded;

    const body = uploadedBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name and cid are required" }, 400);
    const { name, cid } = body.data;
    const expected = service.files.expected(active, name);
    if (!expected) return c.json({ error: `${name} is not part of this run` }, 400);

    const pinned = await ex().pinnedFile(cid);
    if (!pinned || pinned.size !== expected.size || pinned.keyvalues.run !== active.run.id || pinned.keyvalues.file !== name) {
      return c.json({ error: `That upload does not match ${name}` }, 409);
    }

    const credits = await service.files.credits();
    const path = service.files.path(name);
    if (!(await ctx.store.reserve({ id: active.run.id, apiClientId: active.apiClientId, credits, path }))) {
      return c.json({ error: `${name} is already uploaded` }, 409);
    }
    const uri = `ipfs://${cid}`;
    await record(active, path, uri);
    return c.json({ data: { name, uri } }, 201);
  });

  return app;
}
