import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import { createRunRoutes } from "./index.js";
import type { ExecutionDeps } from "./context.js";
import { createMemoryRunStore } from "../../../launchpad/testing/memory-run-store.js";
import type { TicketingDeps } from "../../../launchpad/services/ip-ticketing/chain.js";
import { createRunStepRoutes, type RunServiceSteps } from "./steps.js";
import type { RunContext } from "./context.js";

const OWNER = "0x0123";
const terms = {
  licenseType: "All Rights Reserved", commercialUse: "No", derivatives: "Allowed",
  attribution: "Required", territory: "Worldwide", aiPolicy: "Not Allowed", royalty: 0,
};

const execution = {
  signedUpload: async ({ name }: { name: string }) => `https://uploads.test/${name}`,
  pinnedFile: async () => null,
  pinJson: async () => "ipfs://meta",
  mintCalls: { isCollectionOwner: async () => true },
  registry: () => "0x0789",
  receipt: async () => ({ status: "PENDING" as const, events: [] }),
  sponsored: { clientFactory: () => ({}) as never },
} satisfies ExecutionDeps;

const ticketing: TicketingDeps = {
  factory: () => "0x0f00",
  collectionCalls: async () => [],
  tierCalls: async () => [],
  mintCalls: async () => [],
  resolveWallets: async (guests) => guests.map((g) => ({ email: g, walletAddress: null })),
  registerWallet: async () => ({ status: 502, message: "no" }),
};

async function world() {
  const store = createMemoryRunStore({ balances: { ac1: 1000 }, wallets: [`acct-ac1:${OWNER}`] });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-ac1", status: "ACTIVE" });
    c.set("apiCredits", { id: "ac1", accountId: "acct-ac1", creditBalance: 0 });
    await next();
  });
  app.route("/", createRunRoutes({ store, priceOf: async () => 1, execution, ticketing }));
  const send = (path: string, body: unknown = { userAddress: OWNER }) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  await send("/", {
    service: "ip-ticketing",
    spec: {
      collection: { kind: "existing", collectionId: "1", contractAddress: "0xabc" },
      terms: { ...terms, transferable: "Allowed" },
      name: "Pass",
      guests: ["ana@x.com"],
    },
  });
  await send("/", {
    service: "data-tokenization-erc721",
    spec: {
      collection: { kind: "existing", collectionId: "1", contractAddress: "0xabc" },
      terms,
      items: [{ name: "R", ipType: "Documents", placement: "image", file: { name: "r.png", size: 5, type: "image/png" } }],
    },
  });
  await send("/run1/checkout", { method: "credits" });
  await send("/run2/checkout", { method: "credits" });
  return { send };
}

describe("run steps live on one set of paths, whichever service the run belongs to", () => {
  test("a ticketing run reaches its steps on the bare paths", async () => {
    const { send } = await world();
    for (const path of ["collection", "tier", "batches/0"]) {
      const res = await send(`/run1/${path}/build`);
      expect([200, 400, 409]).toContain(res.status);
    }
    expect((await send("/run1/wallets/resolve", {})).status).toBe(200);
    expect((await send("/run1/metadata")).status).not.toBe(404);
    expect((await send("/run1/files/upload-url", { name: "a.png" })).status).toBe(400);
  });

  test("a step the run's service does not have is refused, not silently answered by another service", async () => {
    const { send } = await world();
    expect((await send("/run2/tier/build")).status).toBe(400);
    expect((await send("/run2/wallets/resolve", {})).status).toBe(400);
    expect((await send("/run2/metadata")).status).toBe(400);
    expect((await send("/run1/items/0/metadata")).status).toBe(400);
  });

  test("each service still reaches its own steps", async () => {
    const { send } = await world();
    expect((await send("/run2/items/0/metadata")).status).toBe(409);
    expect((await send("/run2/files/upload-url", { name: "r.png" })).status).toBe(201);
    expect((await send("/run1/files/upload-url", { name: "other.png" })).status).toBe(400);
  });

  test("the old /ticketing prefix is gone", async () => {
    const { send } = await world();
    expect((await send("/run1/ticketing/wallets/resolve", {})).status).toBe(404);
    expect((await send("/run1/ticketing/tier/build")).status).toBe(404);
    expect((await send("/run1/wallets/resolve", {})).status).toBe(200);
  });
});

describe("a route collision between two services' extra() handlers", () => {
  test("fails fast at startup instead of letting one service's handler silently shadow the other's", () => {
    const fakeCtx = {} as RunContext;

    const serviceA: RunServiceSteps<never> = {
      service: "service-a",
      load: (run) => run as never,
      sponsored: [],
      files: { expected: () => null, uri: () => null, path: () => [], credits: async () => 0 },
      extra(app) {
        app.post("/shared-path", (c) => c.json({ from: "a" }));
      },
    };
    const serviceB: RunServiceSteps<never> = {
      service: "service-b",
      load: (run) => run as never,
      sponsored: [],
      files: { expected: () => null, uri: () => null, path: () => [], credits: async () => 0 },
      extra(app) {
        app.post("/shared-path", (c) => c.json({ from: "b" }));
      },
    };

    expect(() => createRunStepRoutes(fakeCtx, [serviceA, serviceB])).toThrow(
      /Route collision.*service-a.*service-b|Route collision.*service-b.*service-a/,
    );
  });

  test("two services registering different paths is unaffected", () => {
    const fakeCtx = {} as RunContext;
    const serviceA: RunServiceSteps<never> = {
      service: "service-a",
      load: (run) => run as never,
      sponsored: [],
      files: { expected: () => null, uri: () => null, path: () => [], credits: async () => 0 },
      extra(app) {
        app.post("/path-a", (c) => c.json({ from: "a" }));
      },
    };
    const serviceB: RunServiceSteps<never> = {
      service: "service-b",
      load: (run) => run as never,
      sponsored: [],
      files: { expected: () => null, uri: () => null, path: () => [], credits: async () => 0 },
      extra(app) {
        app.post("/path-b", (c) => c.json({ from: "b" }));
      },
    };

    expect(() => createRunStepRoutes(fakeCtx, [serviceA, serviceB])).not.toThrow();
  });
});
