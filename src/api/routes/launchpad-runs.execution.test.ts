import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hash, num } from "starknet";
import type { AppEnv } from "../../types/hono.js";
import { createRunRoutes, type ExecutionDeps, type ReceiptEvent, type ReceiptStatus } from "./launchpad-runs.js";
import { COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import type { RunStore, StoredRun } from "../../launchpad/run-store.js";

type Path = string[];

const getPath = (obj: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), obj);

const setPath = (obj: Record<string, unknown>, path: Path, value: unknown) => {
  let node = obj;
  for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
  node[path[path.length - 1]!] = value;
};

const deletePath = (obj: Record<string, unknown>, path: Path) => {
  const parent = getPath(obj, path.slice(0, -1)) as Record<string, unknown> | undefined;
  if (parent) delete parent[path[path.length - 1]!];
};

const OWNER = "0x0123";
const REGISTRY = "0x0789";

function world() {
  const runs: StoredRun[] = [];
  const balances = new Map<string, number>([["ac1", 100]]);
  const refunds: number[] = [];
  const wallets = new Set([`acct-ac1:${OWNER}`]);
  let n = 0;

  const active = (id: string, apiClientId: string) =>
    runs.find((r) => r.id === id && r.apiClientId === apiClientId && (r.status === "PAID" || r.status === "RUNNING"));

  const store: RunStore = {
    async create({ apiClientId, service, spec }) {
      const now = new Date();
      const run: StoredRun = {
        id: `run${++n}`, apiClientId, service, status: "DRAFT", spec, quote: null,
        creditsHeld: 0, creditsSpent: 0, progress: {}, createdAt: now, updatedAt: now,
      };
      runs.push(run);
      return run;
    },
    async updateDraft() { return null; },
    async get(id, apiClientId) { return runs.find((r) => r.id === id && r.apiClientId === apiClientId) ?? null; },
    async list(apiClientId) { return runs.filter((r) => r.apiClientId === apiClientId); },
    async cancelDraft(id, apiClientId) {
      const run = runs.find((r) => r.id === id && r.apiClientId === apiClientId && r.status === "DRAFT");
      if (!run) return null;
      run.status = "CANCELLED";
      return run;
    },
    async countProvisioned() { return 0; },
    async checkout({ id, apiClientId, quote, progress }) {
      const run = runs.find((r) => r.id === id && r.apiClientId === apiClientId && r.status === "DRAFT");
      if (!run) return "not-draft";
      const balance = balances.get(apiClientId) ?? 0;
      if (balance < quote.total) return "insufficient";
      balances.set(apiClientId, balance - quote.total);
      Object.assign(run, { status: "PAID", quote, creditsHeld: quote.total, progress: structuredClone(progress) });
      return "paid";
    },
    async findPayment() { return null; },
    async balance(apiClientId) { return balances.get(apiClientId) ?? 0; },
    async reserve({ id, apiClientId, credits, path, retryReverted }) {
      const run = active(id, apiClientId);
      if (!run || run.creditsSpent + credits > run.creditsHeld) return false;
      const current = getPath(run.progress, path);
      const reverted = retryReverted && (current as { status?: string } | undefined)?.status === "REVERTED";
      if (current !== undefined && !reverted) return false;
      run.creditsSpent += credits;
      run.status = "RUNNING";
      setPath(run.progress as Record<string, unknown>, path, "pending");
      return true;
    },
    async record(id, apiClientId, path, value) {
      const run = runs.find((r) => r.id === id && r.apiClientId === apiClientId);
      if (run) setPath(run.progress as Record<string, unknown>, path, value);
    },
    async release({ id, apiClientId, credits, path }) {
      const run = runs.find((r) => r.id === id && r.apiClientId === apiClientId);
      if (!run) return;
      run.creditsSpent = Math.max(0, run.creditsSpent - credits);
      deletePath(run.progress as Record<string, unknown>, path);
    },
    async ownsWallet(accountId, address) { return wallets.has(`${accountId}:${address}`); },
    async complete({ id, apiClientId, status }) {
      const run = active(id, apiClientId);
      if (!run) return null;
      run.status = status;
      const refunded = Math.max(0, run.creditsHeld - run.creditsSpent);
      balances.set(apiClientId, (balances.get(apiClientId) ?? 0) + refunded);
      refunds.push(refunded);
      return { refunded };
    },
  };

  let receipt: ReceiptStatus = "PENDING";
  let events: ReceiptEvent[] = [];
  const pinned: string[] = [];
  const executed: unknown[] = [];

  const execution: ExecutionDeps = {
    pinFile: async (file) => (pinned.push(file.name), `ipfs://file-${file.name}`),
    pinJson: async (data) => (pinned.push(String(data.name)), `ipfs://meta-${String(data.name)}`),
    mintCalls: { isCollectionOwner: async () => true },
    registry: () => REGISTRY,
    receipt: async () => ({ status: receipt, events }),
    sponsored: {
      addressChecker: { isEligible: async () => true },
      clientFactory: () => ({
        buildTransaction: async (req) => {
          const calls = (req as { invoke: { calls: { contractAddress: string; entrypoint: string; calldata: string[] }[] } }).invoke.calls;
          return {
            typed_data: {
              message: {
                Calls: calls.map((call) => ({
                  To: call.contractAddress,
                  Selector: num.toHex(hash.getSelectorFromName(call.entrypoint)),
                  Calldata: call.calldata,
                })),
              },
            },
          };
        },
        executeTransaction: async (req) => (executed.push(req), { transaction_hash: `0xtx${executed.length}` }),
      }),
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-ac1", status: "ACTIVE" });
    c.set("apiClient", { id: "ac1", accountId: "acct-ac1", plan: "FREE", creditBalance: 0 });
    await next();
  });
  app.route("/", createRunRoutes({ store, priceOf: async () => 2, execution }));

  return {
    app, runs, balances, refunds, pinned, executed,
    setReceipt: (status: ReceiptStatus, next: ReceiptEvent[] = []) => {
      receipt = status;
      events = next;
    },
  };
}

const spec = {
  collection: { kind: "existing", collectionId: "3", contractAddress: "0x1" },
  terms: {
    licenseType: "CC BY-SA", commercialUse: "Yes", derivatives: "Share-Alike",
    attribution: "Required", territory: "Worldwide", aiPolicy: "Allowed", royalty: 5,
  },
  items: [
    {
      name: "Report", ipType: "Documents", placement: "document",
      file: { name: "r.pdf", size: 5, type: "application/pdf" },
      image: { name: "c.png", size: 3, type: "image/png" },
    },
  ],
};

const HELD = 2 * 6;

const json = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const upload = (app: Hono<AppEnv>, name: string, bytes: number, type: string) => {
  const form = new FormData();
  form.set("file", new File(["x".repeat(bytes)], name, { type }));
  return app.request("/run1/files", { method: "POST", body: form });
};

async function paidRun() {
  const w = world();
  await json(w.app, "POST", "/", { service: "data-tokenization-erc721", spec });
  expect((await json(w.app, "POST", "/run1/checkout", { method: "credits" })).status).toBe(200);
  return w;
}

async function readyBatch() {
  const w = await paidRun();
  expect((await upload(w.app, "r.pdf", 5, "application/pdf")).status).toBe(201);
  expect((await upload(w.app, "c.png", 3, "image/png")).status).toBe(201);
  expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: OWNER })).status).toBe(201);
  return w;
}

async function submitBatch(w: Awaited<ReturnType<typeof readyBatch>>) {
  const built = await json(w.app, "POST", "/run1/batches/0/build", { userAddress: OWNER, calls: [] });
  expect(built.status).toBe(200);
  const { typedData } = (await built.json()) as { typedData: unknown };
  return json(w.app, "POST", "/run1/batches/0/execute", { userAddress: OWNER, typedData, signature: ["0x1", "0x2"] });
}

describe("executing a paid run", () => {
  test("nothing executes before the run is paid", async () => {
    const w = world();
    await json(w.app, "POST", "/", { service: "data-tokenization-erc721", spec });
    expect((await upload(w.app, "r.pdf", 5, "application/pdf")).status).toBe(409);
    expect(w.pinned).toEqual([]);
  });

  test("only files named in the spec upload, each one once", async () => {
    const w = await paidRun();
    expect((await upload(w.app, "other.pdf", 5, "application/pdf")).status).toBe(400);
    expect((await upload(w.app, "r.pdf", 9, "application/pdf")).status).toBe(400);
    expect((await upload(w.app, "r.pdf", 5, "application/pdf")).status).toBe(201);
    expect((await upload(w.app, "r.pdf", 5, "application/pdf")).status).toBe(409);
    expect(w.pinned).toEqual(["r.pdf"]);
    expect(w.runs[0]!.creditsSpent).toBe(2);
  });

  test("metadata is built by the run, for a wallet on the caller's account, once its files are in", async () => {
    const w = await paidRun();
    expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: "0xbeef" })).status).toBe(403);
    expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: OWNER })).status).toBe(409);
    await upload(w.app, "r.pdf", 5, "application/pdf");
    await upload(w.app, "c.png", 3, "image/png");
    expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: OWNER })).status).toBe(201);
    const progress = w.runs[0]!.progress as { tokenUris: Record<string, string> };
    expect(progress.tokenUris["0"]).toBe("ipfs://meta-Report");
  });

  test("a batch runs the run's own calls, whatever the client sends, and completes the run", async () => {
    const w = await readyBatch();
    const submitted = await submitBatch(w);
    expect(submitted.status).toBe(200);
    expect((await submitted.json()) as unknown).toEqual({ transactionHash: "0xtx1" });
    expect((await json(w.app, "POST", "/run1/batches/0/build", { userAddress: OWNER })).status).toBe(409);

    const pending = await json(w.app, "POST", "/run1/batches/0/confirm");
    expect(pending.status).toBe(202);

    w.setReceipt("SUCCEEDED");
    const confirmed = await json(w.app, "POST", "/run1/batches/0/confirm");
    expect(((await confirmed.json()) as { data: { completed: boolean } }).data.completed).toBe(true);
    expect(w.runs[0]!.status).toBe("COMPLETED");
    expect(w.runs[0]!.creditsSpent).toBe(HELD);
    expect(w.refunds).toEqual([0]);
  });

  test("a reverted batch returns its mint and gas credits and can run again", async () => {
    const w = await readyBatch();
    await submitBatch(w);
    const spentBefore = w.runs[0]!.creditsSpent;
    w.setReceipt("REVERTED");
    await json(w.app, "POST", "/run1/batches/0/confirm");
    expect(w.runs[0]!.creditsSpent).toBe(spentBefore - 6);

    const retried = await submitBatch(w);
    expect(retried.status).toBe(200);
    expect(w.executed).toHaveLength(2);
  });

  test("resume reads the next step from the run", async () => {
    const w = await paidRun();
    await upload(w.app, "r.pdf", 5, "application/pdf");
    const res = await w.app.request("/run1");
    const { data } = (await res.json()) as { data: { next: { kind: string; files: string[] } } };
    expect(data.next).toEqual({ kind: "upload", files: ["c.png"] });
  });

  test("cancelling a paid run refunds what it did not spend, but not while a batch is landing", async () => {
    const w = await readyBatch();
    await submitBatch(w);
    expect((await json(w.app, "POST", "/run1/cancel")).status).toBe(409);

    const fresh = await paidRun();
    await upload(fresh.app, "r.pdf", 5, "application/pdf");
    const balanceBefore = fresh.balances.get("ac1")!;
    const cancelled = await json(fresh.app, "POST", "/run1/cancel");
    expect(cancelled.status).toBe(200);
    expect(fresh.runs[0]!.status).toBe("CANCELLED");
    expect(fresh.balances.get("ac1")).toBe(balanceBefore + HELD - 2);
  });
});

describe("a run that creates its own collection", () => {
  const newCollection = { ...spec, collection: { kind: "new", name: "Archive", symbol: "ARC" } };

  async function paidNewCollectionRun() {
    const w = world();
    w.balances.set("ac1", 100);
    await json(w.app, "POST", "/", { service: "data-tokenization-erc721", spec: newCollection });
    expect((await json(w.app, "POST", "/run1/checkout", { method: "credits" })).status).toBe(200);
    return w;
  }

  test("the collection comes first, then the id from the registry's event unlocks the batches", async () => {
    const w = await paidNewCollectionRun();
    const first = (await (await w.app.request("/run1")).json()) as { data: { next: { kind: string } } };
    expect(first.data.next.kind).toBe("collection");

    await upload(w.app, "r.pdf", 5, "application/pdf");
    await upload(w.app, "c.png", 3, "image/png");
    await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: OWNER });
    expect((await json(w.app, "POST", "/run1/batches/0/build", { userAddress: OWNER })).status).toBe(409);

    const built = await json(w.app, "POST", "/run1/collection/build", { userAddress: OWNER });
    expect(built.status).toBe(200);
    const { typedData } = (await built.json()) as { typedData: unknown };
    const executed = await json(w.app, "POST", "/run1/collection/execute", { userAddress: OWNER, typedData, signature: ["0x1", "0x2"] });
    expect(executed.status).toBe(200);

    w.setReceipt("SUCCEEDED", [
      { from_address: REGISTRY, keys: [COLLECTION_CREATED_SELECTOR, "0x2a", "0x0"], data: [OWNER] },
    ]);
    const confirmed = await json(w.app, "POST", "/run1/collection/confirm");
    expect(((await confirmed.json()) as { data: { collectionId: string } }).data.collectionId).toBe("42");

    w.setReceipt("PENDING");
    const batch = await submitBatch(w);
    expect(batch.status).toBe(200);
    const calls = (w.executed[1] as { invoke: { typedData: { message: { Calls: { Calldata: string[] }[] } } } }).invoke
      .typedData.message.Calls;
    expect(calls[0]!.Calldata[0]).toBe("42");
  });

  test("the collection metadata is pinned once, however many times it is built", async () => {
    const w = await paidNewCollectionRun();
    await json(w.app, "POST", "/run1/collection/build", { userAddress: OWNER });
    await json(w.app, "POST", "/run1/collection/build", { userAddress: OWNER });
    expect(w.pinned.filter((name) => name === "Archive")).toHaveLength(1);
  });

  test("a reverted collection hands back its credits and can be created again", async () => {
    const w = await paidNewCollectionRun();
    const built = await json(w.app, "POST", "/run1/collection/build", { userAddress: OWNER });
    const { typedData } = (await built.json()) as { typedData: unknown };
    await json(w.app, "POST", "/run1/collection/execute", { userAddress: OWNER, typedData, signature: ["0x1"] });
    const spent = w.runs[0]!.creditsSpent;

    w.setReceipt("REVERTED");
    await json(w.app, "POST", "/run1/collection/confirm");
    expect(w.runs[0]!.creditsSpent).toBe(spent - 6);
    expect((await json(w.app, "POST", "/run1/collection/execute", { userAddress: OWNER, typedData, signature: ["0x1"] })).status).toBe(200);
  });
});
