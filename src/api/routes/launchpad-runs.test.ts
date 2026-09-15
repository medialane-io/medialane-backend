import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createRunRoutes } from "./launchpad-runs.js";
import type { RunStore, StoredRun } from "../../launchpad/run-store.js";

function memoryStore(): RunStore & { runs: StoredRun[] } {
  const runs: StoredRun[] = [];
  let n = 0;
  return {
    runs,
    async create({ apiClientId, service, spec }) {
      const now = new Date();
      const run: StoredRun = {
        id: `run${++n}`,
        apiClientId,
        service,
        status: "DRAFT",
        spec,
        quote: null,
        creditsHeld: 0,
        creditsSpent: 0,
        progress: {},
        createdAt: now,
        updatedAt: now,
      };
      runs.push(run);
      return run;
    },
    async updateDraft(id, apiClientId, spec) {
      const run = runs.find((r) => r.id === id && r.apiClientId === apiClientId && r.status === "DRAFT");
      if (!run) return null;
      run.spec = spec;
      return run;
    },
    async get(id, apiClientId) {
      return runs.find((r) => r.id === id && r.apiClientId === apiClientId) ?? null;
    },
    async list(apiClientId) {
      return runs.filter((r) => r.apiClientId === apiClientId);
    },
    async cancelDraft(id, apiClientId) {
      const run = runs.find((r) => r.id === id && r.apiClientId === apiClientId && r.status === "DRAFT");
      if (!run) return null;
      run.status = "CANCELLED";
      return run;
    },
    async countProvisioned() {
      return 0;
    },
  };
}

function appFor(store: RunStore, apiClientId = "ac1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: `acct-${apiClientId}`, status: "ACTIVE" });
    c.set("apiClient", { id: apiClientId, accountId: `acct-${apiClientId}`, plan: "FREE", creditBalance: 0 });
    await next();
  });
  app.route("/", createRunRoutes({ store, priceOf: async () => 2 }));
  return app;
}

const spec = {
  collection: { kind: "existing", collectionId: "1", contractAddress: "0x1" },
  terms: {
    licenseType: "CC BY-SA",
    commercialUse: "Yes",
    derivatives: "Share-Alike",
    attribution: "Required",
    territory: "Worldwide",
    aiPolicy: "Allowed",
    royalty: 0,
  },
  items: [{ name: "One", ipType: "Documents", file: { name: "one.pdf", size: 10, type: "application/pdf" } }],
};

const post = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const patch = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("launchpad run drafts", () => {
  test("saving a draft stores it and returns its quote", async () => {
    const store = memoryStore();
    const res = await post(appFor(store), "/", { service: "data-tokenization-erc721", spec });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { status: string; quote: { total: number } } };
    expect(data.status).toBe("DRAFT");
    expect(data.quote.total).toBeGreaterThan(0);
    expect(store.runs).toHaveLength(1);
  });

  test("an incomplete draft is refused with what is missing", async () => {
    const res = await post(appFor(memoryStore()), "/", { service: "data-tokenization-erc721", spec: { items: [] } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test("a run is invisible to every other account", async () => {
    const store = memoryStore();
    await post(appFor(store, "ac1"), "/", { service: "data-tokenization-erc721", spec });
    const other = appFor(store, "ac2");
    expect((await other.request("/run1")).status).toBe(404);
    expect(((await (await other.request("/")).json()) as { data: unknown[] }).data).toHaveLength(0);
    expect((await patch(other, "/run1", { spec })).status).toBe(404);
  });

  test("a draft can be edited and a paid run cannot", async () => {
    const store = memoryStore();
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });
    const renamed = { ...spec, items: [{ ...spec.items[0], name: "Renamed" }] };
    expect((await patch(app, "/run1", { spec: renamed })).status).toBe(200);

    store.runs[0]!.status = "PAID";
    expect((await patch(app, "/run1", { spec })).status).toBe(409);
  });

  test("a draft can be cancelled, a paid run is not cancelled from here", async () => {
    const store = memoryStore();
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });
    await post(app, "/", { service: "data-tokenization-erc721", spec });
    expect((await post(app, "/run1/cancel", {})).status).toBe(200);
    store.runs[1]!.status = "PAID";
    expect((await post(app, "/run2/cancel", {})).status).toBe(409);
  });
});
