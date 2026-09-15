import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hash, num } from "starknet";
import type { AppEnv } from "../../../types/hono.js";
import { createRunRoutes } from "./index.js";
import { MAX_UPLOAD_URLS_PER_FILE } from "./data-tokenization.js";
import type { ExecutionDeps, ReceiptEvent, ReceiptStatus } from "./context.js";
import { COLLECTION_CREATED_SELECTOR } from "../../../config/constants.js";
import { createMemoryRunStore } from "../../../launchpad/testing/memory-run-store.js";

const OWNER = "0x0123";
const REGISTRY = "0x0789";

function world() {
  const store = createMemoryRunStore({ balances: { ac1: 100 }, wallets: [`acct-ac1:${OWNER}`] });
  const { runs, balances, refunds } = store;

  let receipt: ReceiptStatus = "PENDING";
  let events: ReceiptEvent[] = [];
  const pinned: string[] = [];
  const issued: string[] = [];
  const pins = new Map<string, { size: number; keyvalues: Record<string, string> }>();
  const executed: unknown[] = [];

  const execution: ExecutionDeps = {
    signedUpload: async ({ name }) => (issued.push(name), `https://uploads.test/${name}`),
    pinnedFile: async (cid) => pins.get(cid) ?? null,
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
    app, runs, balances, refunds, pinned, issued, pins, executed,
    setReceipt: (status: ReceiptStatus, next: ReceiptEvent[] = []) => {
      receipt = status;
      events = next;
    },
  };
}

type World = ReturnType<typeof world>;

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

async function upload(w: World, name: string, bytes: number, runId = "run1") {
  const urlRes = await json(w.app, "POST", `/${runId}/files/upload-url`, { name });
  if (urlRes.status !== 201) return urlRes;
  const cid = `bafy-${name}-${w.issued.length}`;
  w.pins.set(cid, { size: bytes, keyvalues: { run: runId, file: name } });
  return json(w.app, "POST", `/${runId}/files/uploaded`, { name, cid });
}

async function paidRun() {
  const w = world();
  await json(w.app, "POST", "/", { service: "data-tokenization-erc721", spec });
  expect((await json(w.app, "POST", "/run1/checkout", { method: "credits" })).status).toBe(200);
  return w;
}

async function readyBatch() {
  const w = await paidRun();
  expect((await upload(w, "r.pdf", 5)).status).toBe(201);
  expect((await upload(w, "c.png", 3)).status).toBe(201);
  expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: OWNER })).status).toBe(201);
  return w;
}

async function submitBatch(w: World) {
  const built = await json(w.app, "POST", "/run1/batches/0/build", { userAddress: OWNER, calls: [] });
  expect(built.status).toBe(200);
  const { typedData } = (await built.json()) as { typedData: unknown };
  return json(w.app, "POST", "/run1/batches/0/execute", { userAddress: OWNER, typedData, signature: ["0x1", "0x2"] });
}

describe("uploading a paid run's files", () => {
  test("nothing uploads before the run is paid", async () => {
    const w = world();
    await json(w.app, "POST", "/", { service: "data-tokenization-erc721", spec });
    expect((await upload(w, "r.pdf", 5)).status).toBe(409);
    expect(w.issued).toEqual([]);
  });

  test("an upload URL is only issued for a file named in the spec", async () => {
    const w = await paidRun();
    expect((await json(w.app, "POST", "/run1/files/upload-url", { name: "other.pdf" })).status).toBe(400);
    expect(w.issued).toEqual([]);
  });

  test("a file counts only when the pinned upload matches its size and this run, and only once", async () => {
    const w = await paidRun();
    expect((await upload(w, "r.pdf", 9)).status).toBe(409);
    expect(w.runs[0]!.creditsSpent).toBe(0);

    expect((await upload(w, "r.pdf", 5)).status).toBe(201);
    expect(w.runs[0]!.creditsSpent).toBe(2);
    expect((w.runs[0]!.progress as { files: Record<string, string> }).files["r.pdf"]).toMatch(/^ipfs:\/\/bafy-r\.pdf-/);

    expect((await upload(w, "r.pdf", 5)).status).toBe(409);
    expect(w.runs[0]!.creditsSpent).toBe(2);
  });

  test("a pin from another run or file does not count", async () => {
    const w = await paidRun();
    await json(w.app, "POST", "/run1/files/upload-url", { name: "r.pdf" });
    w.pins.set("bafy-elsewhere", { size: 5, keyvalues: { run: "run9", file: "r.pdf" } });
    expect((await json(w.app, "POST", "/run1/files/uploaded", { name: "r.pdf", cid: "bafy-elsewhere" })).status).toBe(409);
    w.pins.set("bafy-other-file", { size: 5, keyvalues: { run: "run1", file: "c.png" } });
    expect((await json(w.app, "POST", "/run1/files/uploaded", { name: "r.pdf", cid: "bafy-other-file" })).status).toBe(409);
  });

  test("each file gets a limited number of upload URLs", async () => {
    const w = await paidRun();
    for (let i = 0; i < MAX_UPLOAD_URLS_PER_FILE; i++) {
      expect((await json(w.app, "POST", "/run1/files/upload-url", { name: "r.pdf" })).status).toBe(201);
    }
    expect((await json(w.app, "POST", "/run1/files/upload-url", { name: "r.pdf" })).status).toBe(429);
  });
});

describe("executing a paid run", () => {
  test("metadata is built by the run, for a wallet on the caller's account, once its files are in", async () => {
    const w = await paidRun();
    expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: "0xbeef" })).status).toBe(403);
    expect((await json(w.app, "POST", "/run1/items/0/metadata", { userAddress: OWNER })).status).toBe(409);
    await upload(w, "r.pdf", 5);
    await upload(w, "c.png", 3);
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
    await upload(w, "r.pdf", 5);
    const res = await w.app.request("/run1");
    const { data } = (await res.json()) as { data: { next: { kind: string; files: string[] } } };
    expect(data.next).toEqual({ kind: "upload", files: ["c.png"] });
  });

  test("cancelling a paid run refunds what it did not spend, but not while a batch is landing", async () => {
    const w = await readyBatch();
    await submitBatch(w);
    expect((await json(w.app, "POST", "/run1/cancel")).status).toBe(409);

    const fresh = await paidRun();
    await upload(fresh, "r.pdf", 5);
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
    await json(w.app, "POST", "/", { service: "data-tokenization-erc721", spec: newCollection });
    expect((await json(w.app, "POST", "/run1/checkout", { method: "credits" })).status).toBe(200);
    return w;
  }

  test("the collection comes first, then the id from the registry's event unlocks the batches", async () => {
    const w = await paidNewCollectionRun();
    const first = (await (await w.app.request("/run1")).json()) as { data: { next: { kind: string } } };
    expect(first.data.next.kind).toBe("collection");

    await upload(w, "r.pdf", 5);
    await upload(w, "c.png", 3);
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
