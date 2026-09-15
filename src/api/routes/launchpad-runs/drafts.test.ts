import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import { createRunRoutes } from "./index.js";
import type { SettleWalletPayment } from "./context.js";
import { createMemoryRunStore, type MemoryRunStore } from "../../../launchpad/testing/memory-run-store.js";

function appFor(store: MemoryRunStore, apiClientId = "ac1", settleWalletPayment?: SettleWalletPayment) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: `acct-${apiClientId}`, status: "ACTIVE" });
    c.set("apiClient", { id: apiClientId, accountId: `acct-${apiClientId}`, plan: "FREE", creditBalance: 0 });
    await next();
  });
  app.route("/", createRunRoutes({ store, priceOf: async () => 2, settleWalletPayment }));
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
  items: [
    {
      name: "One",
      ipType: "Documents",
      placement: "document",
      file: { name: "one.pdf", size: 10, type: "application/pdf" },
      image: { name: "cover.png", size: 10, type: "image/png" },
    },
  ],
};

const QUOTE_TOTAL = 2 * 6;

const post = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const patch = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("launchpad run drafts", () => {
  test("saving a draft stores it and returns its quote", async () => {
    const store = createMemoryRunStore();
    const res = await post(appFor(store), "/", { service: "data-tokenization-erc721", spec });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { status: string; quote: { total: number } } };
    expect(data.status).toBe("DRAFT");
    expect(data.quote.total).toBe(QUOTE_TOTAL);
    expect(store.runs).toHaveLength(1);
  });

  test("an incomplete draft is refused with what is missing", async () => {
    const res = await post(appFor(createMemoryRunStore()), "/", { service: "data-tokenization-erc721", spec: { items: [] } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test("a run is invisible to every other account", async () => {
    const store = createMemoryRunStore();
    await post(appFor(store, "ac1"), "/", { service: "data-tokenization-erc721", spec });
    const other = appFor(store, "ac2");
    expect((await other.request("/run1")).status).toBe(404);
    expect(((await (await other.request("/")).json()) as { data: unknown[] }).data).toHaveLength(0);
    expect((await patch(other, "/run1", { spec })).status).toBe(404);
    expect((await post(other, "/run1/checkout", { method: "credits" })).status).toBe(404);
  });

  test("a draft can be edited and a paid run cannot", async () => {
    const store = createMemoryRunStore();
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });
    const renamed = { ...spec, items: [{ ...spec.items[0], name: "Renamed" }] };
    expect((await patch(app, "/run1", { spec: renamed })).status).toBe(200);

    store.runs[0]!.status = "PAID";
    expect((await patch(app, "/run1", { spec })).status).toBe(409);
  });

  test("a draft is cancelled outright", async () => {
    const store = createMemoryRunStore();
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });
    expect((await post(app, "/run1/cancel", {})).status).toBe(200);
    expect(store.runs[0]!.status).toBe("CANCELLED");
    expect((await post(app, "/run1/cancel", {})).status).toBe(409);
  });
});

describe("checkout", () => {
  test("paying with credits takes the quote once, holds it on the run and records each line", async () => {
    const store = createMemoryRunStore({ balances: { ac1: 50 } });
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });

    const res = await post(app, "/run1/checkout", { method: "credits" });
    expect(res.status).toBe(200);
    expect(store.balances.get("ac1")).toBe(50 - QUOTE_TOTAL);
    expect(store.runs[0]!.status).toBe("PAID");
    expect(store.runs[0]!.creditsHeld).toBe(QUOTE_TOTAL);
    expect(store.usage.reduce((s, u) => s + u.credits, 0)).toBe(QUOTE_TOTAL);

    expect((await post(app, "/run1/checkout", { method: "credits" })).status).toBe(409);
    expect(store.balances.get("ac1")).toBe(50 - QUOTE_TOTAL);
  });

  test("too few credits changes nothing and says how many are missing", async () => {
    const store = createMemoryRunStore({ balances: { ac1: 3 } });
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });

    const res = await post(app, "/run1/checkout", { method: "credits" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { data: { shortfall: number } };
    expect(body.data.shortfall).toBe(QUOTE_TOTAL - 3);
    expect(store.runs[0]!.status).toBe("DRAFT");
    expect(store.balances.get("ac1")).toBe(3);
  });

  test("paying from the wallet credits the transfer, then pays the run from it", async () => {
    const store = createMemoryRunStore();
    const app = appFor(store, "ac1", async () => {
      store.balances.set("ac1", (store.balances.get("ac1") ?? 0) + 20);
      return { payments: [{ paymentId: "pay1", apiClientId: "ac1" }] };
    });
    await post(app, "/", { service: "data-tokenization-erc721", spec });

    const res = await post(app, "/run1/checkout", { method: "wallet", txHash: "0xabc" });
    expect(res.status).toBe(200);
    expect(store.runs[0]!.status).toBe("PAID");
    expect(store.balances.get("ac1")).toBe(20 - QUOTE_TOTAL);
  });

  test("a wallet payment that belongs to another account pays nothing", async () => {
    const store = createMemoryRunStore();
    const app = appFor(store, "ac1", async () => ({ payments: [{ paymentId: "pay9", apiClientId: "ac2" }] }));
    await post(app, "/", { service: "data-tokenization-erc721", spec });

    const res = await post(app, "/run1/checkout", { method: "wallet", txHash: "0xdef" });
    expect(res.status).toBe(402);
    expect(store.runs[0]!.status).toBe("DRAFT");
  });

  test("a checkout without a method is refused", async () => {
    const store = createMemoryRunStore();
    const app = appFor(store);
    await post(app, "/", { service: "data-tokenization-erc721", spec });
    expect((await post(app, "/run1/checkout", { method: "card" })).status).toBe(400);
  });
});
