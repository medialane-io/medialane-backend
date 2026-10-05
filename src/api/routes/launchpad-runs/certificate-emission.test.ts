import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hash, num } from "starknet";
import type { AppEnv } from "../../../types/hono.js";
import { createRunRoutes } from "./index.js";
import type { ExecutionDeps, ReceiptEvent, ReceiptStatus } from "./context.js";
import { COLLECTION_CREATED_SELECTOR } from "../../../config/constants.js";
import { encodeByteArray } from "../../../orchestrator/intent/shared.js";
import { createMemoryRunStore } from "../../../launchpad/testing/memory-run-store.js";
import type { CertificateEmissionDeps } from "../../../launchpad/services/certificate-emission/chain.js";

const OWNER = "0x0123";
const REGISTRY = "0x0789";
interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}
const GROUP = "0x0abc";
const PRICE = 2;

function world(options: { known?: Record<string, string>; deploy?: "ok" | "fail" } = {}) {
  const store = createMemoryRunStore({ balances: { ac1: 100 }, wallets: [`acct-ac1:${OWNER}`] });
  const { runs, balances, refunds } = store;

  let receipt: ReceiptStatus = "PENDING";
  let events: ReceiptEvent[] = [];
  const known: Record<string, string> = { ...options.known };
  const pins = new Map<string, { size: number; keyvalues: Record<string, string> }>();
  const issued: string[] = [];
  const pinned: unknown[] = [];
  const executed: unknown[] = [];
  const registered: string[] = [];

  const execution: ExecutionDeps = {
    signedUpload: async ({ name }) => (issued.push(name), `https://uploads.test/${name}`),
    pinnedFile: async (cid) => pins.get(cid) ?? null,
    pinJson: async (data) => (pinned.push(data), `ipfs://meta-${pinned.length}`),
    mintCalls: { isCollectionOwner: async () => true },
    registry: () => REGISTRY,
    receipt: async () => ({ status: receipt, events }),
    sponsored: {
      clientFactory: () => ({
        buildTransaction: async (req) => {
          const calls = (req as { invoke: { calls: Call[] } }).invoke.calls;
          return {
            deployment: (req as { deployment?: unknown }).deployment,
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

  const certificateEmission: CertificateEmissionDeps = {
    resolveWallets: async (guests) => guests.map((g) => ({ email: g, walletAddress: known[g] ?? null })),
    registerWallet: async (input) => {
      if (options.deploy === "fail") return { status: 502, message: "deploy failed" };
      registered.push(input.email);
      const walletAddress = `0xa${registered.length}`;
      known[input.email] = walletAddress;
      return { status: 201, reused: false, walletAddress };
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acct-ac1", status: "ACTIVE" });
    c.set("apiCredits", { id: "ac1", accountId: "acct-ac1", plan: "FREE", creditBalance: 0 });
    await next();
  });
  app.route("/", createRunRoutes({ store, priceOf: async () => PRICE, execution, certificateEmission }));

  return {
    app, runs, balances, refunds, pins, pinned, issued, executed, registered,
    setReceipt: (status: ReceiptStatus, next: ReceiptEvent[] = []) => {
      receipt = status;
      events = next;
    },
  };
}

type World = ReturnType<typeof world>;

const spec = {
  collection: { kind: "existing", collectionId: "1", contractAddress: GROUP },
  terms: {
    licenseType: "CC BY-SA", commercialUse: "Yes", derivatives: "Share-Alike",
    attribution: "Required", territory: "Worldwide", aiPolicy: "Not Allowed", royalty: 0,
  },
  name: "Course completion",
  artwork: { name: "a.png", size: 3, type: "image/png" },
  guests: ["ana@x.com", "bruno@x.com"],
};

/** file + metadata + two wallets + one emission batch of two — no tier step */
const HELD = PRICE * (1 + 1 + 3 * 2) + PRICE * (1 * 2 + 2);

const json = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function paid(overrides: Record<string, unknown> = {}, options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  await json(w.app, "POST", "/", { service: "certificate-emission", spec: { ...spec, ...overrides } });
  expect((await json(w.app, "POST", "/run1/checkout", { method: "credits" })).status).toBe(200);
  return w;
}

async function uploadArtwork(w: World) {
  expect((await json(w.app, "POST", "/run1/files/upload-url", { name: "a.png" })).status).toBe(201);
  w.pins.set("bafy-artwork-cid", { size: 3, keyvalues: { run: "run1", file: "a.png" } });
  return json(w.app, "POST", "/run1/files/uploaded", { name: "a.png", cid: "bafy-artwork-cid" });
}

const metadata = (w: World) => json(w.app, "POST", "/run1/certificate-metadata", { userAddress: OWNER });

async function sponsor(w: World, path: string) {
  const built = await json(w.app, "POST", `/run1/${path}/build`, { userAddress: OWNER });
  if (built.status !== 200) return built;
  const { typedData } = (await built.json()) as { typedData: unknown };
  return json(w.app, "POST", `/run1/${path}/execute`, { userAddress: OWNER, typedData, signature: ["0x1", "0x2"] });
}

async function withMetadata() {
  const w = await paid();
  await uploadArtwork(w);
  await metadata(w);
  return w;
}

const wallet = (recipient: string) => ({ recipient });

async function withWallets() {
  const w = await withMetadata();
  for (const guest of spec.guests) expect((await json(w.app, "POST", "/run1/recipients", wallet(guest))).status).toBe(201);
  return w;
}

const nextOf = async (w: World) =>
  ((await (await w.app.request("/run1")).json()) as { data: { next: { kind: string } } }).data.next;

describe("a run only executes once it is paid, and only its own service", () => {
  test("nothing uploads or is stored before the run is paid", async () => {
    const w = world();
    await json(w.app, "POST", "/", { service: "certificate-emission", spec });
    expect((await json(w.app, "POST", "/run1/files/upload-url", { name: "a.png" })).status).toBe(409);
    expect((await metadata(w)).status).toBe(409);
    expect(w.issued).toEqual([]);
  });

  test("a run of another service cannot use certificate-emission's own routes", async () => {
    const w = world();
    await json(w.app, "POST", "/", {
      service: "data-tokenization-erc721",
      spec: {
        collection: { kind: "existing", collectionId: "3", contractAddress: "0x1" },
        terms: {
          licenseType: "All Rights Reserved", commercialUse: "No", derivatives: "Allowed",
          attribution: "Required", territory: "Worldwide", aiPolicy: "Not Allowed", royalty: 0,
        },
        items: [{ name: "R", ipType: "Documents", placement: "image", file: { name: "r.png", size: 5, type: "image/png" } }],
      },
    });
    await json(w.app, "POST", "/run1/checkout", { method: "credits" });
    expect((await json(w.app, "POST", "/run1/recipients", wallet("ana@x.com"))).status).toBe(400);
  });
});

describe("the artwork", () => {
  test("counts only when the pinned upload matches its size and this run, and only once", async () => {
    const w = await paid();
    await json(w.app, "POST", "/run1/files/upload-url", { name: "a.png" });
    w.pins.set("bafy-wrong", { size: 9, keyvalues: { run: "run1", file: "a.png" } });
    expect((await json(w.app, "POST", "/run1/files/uploaded", { name: "a.png", cid: "bafy-wrong" })).status).toBe(409);
    expect(w.runs[0]!.creditsSpent).toBe(0);

    expect((await uploadArtwork(w)).status).toBe(201);
    expect(w.runs[0]!.creditsSpent).toBe(PRICE);
    const again = await json(w.app, "POST", "/run1/files/uploaded", { name: "a.png", cid: "bafy-artwork-cid" });
    expect(again.status).toBe(409);
    expect(w.runs[0]!.creditsSpent).toBe(PRICE);
  });

  test("a run without artwork has nothing to upload", async () => {
    const w = await paid({ artwork: undefined });
    expect((await json(w.app, "POST", "/run1/files/upload-url", { name: "a.png" })).status).toBe(400);
  });
});

describe("the certificate's metadata", () => {
  test("is built by the run, for a wallet on the caller's account, once the artwork is in", async () => {
    const w = await paid();
    expect((await json(w.app, "POST", "/run1/certificate-metadata", { userAddress: "0xbeef" })).status).toBe(403);
    expect((await metadata(w)).status).toBe(409);
    await uploadArtwork(w);
    expect((await metadata(w)).status).toBe(201);
    expect((w.runs[0]!.progress as { tokenUri: string }).tokenUri).toBe("ipfs://meta-1");
    expect((w.pinned[0] as { name: string }).name).toBe("Course completion");
    expect((await metadata(w)).status).toBe(409);
  });

  test("wallets come right after metadata — there is no tier step", async () => {
    const w = await withMetadata();
    expect((await nextOf(w)).kind).toBe("wallets");
  });
});

describe("guest wallets", () => {
  test("guests without a wallet are listed to be prepared, and listing costs nothing", async () => {
    const w = await withMetadata();
    const spentBefore = w.runs[0]!.creditsSpent;

    const res = await json(w.app, "POST", "/run1/recipients/resolve");
    expect(((await res.json()) as { data: { pending: string[] } }).data.pending).toEqual(["ana@x.com", "bruno@x.com"]);
    expect(w.runs[0]!.creditsSpent).toBe(spentBefore);
  });

  test("a wallet that exists is recorded without spending credits", async () => {
    const w = world({ known: { "ana@x.com": "0xana" } });
    await json(w.app, "POST", "/", { service: "certificate-emission", spec });
    await json(w.app, "POST", "/run1/checkout", { method: "credits" });
    const res = await json(w.app, "POST", "/run1/recipients/resolve");
    expect(((await res.json()) as { data: { pending: string[] } }).data.pending).toEqual(["bruno@x.com"]);
    expect((w.runs[0]!.progress as { wallets: Record<string, string> }).wallets["ana@x.com"]).toBe("0xana");
    expect(w.runs[0]!.creditsSpent).toBe(0);
  });

  test("preparing a wallet spends its credits once, and records the address", async () => {
    const w = await withMetadata();
    const before = w.runs[0]!.creditsSpent;
    expect((await json(w.app, "POST", "/run1/recipients", wallet("ana@x.com"))).status).toBe(201);
    expect(w.runs[0]!.creditsSpent).toBe(before + PRICE * 3);
    expect((w.runs[0]!.progress as { wallets: Record<string, string> }).wallets["ana@x.com"]).toBe("0xa1");
    expect((await json(w.app, "POST", "/run1/recipients", wallet("ana@x.com"))).status).toBe(409);
    expect(w.runs[0]!.creditsSpent).toBe(before + PRICE * 3);
  });

  test("only someone on the guest list gets a wallet", async () => {
    const w = await withMetadata();
    expect((await json(w.app, "POST", "/run1/recipients", wallet("eve@x.com"))).status).toBe(400);
    expect(w.registered).toEqual([]);
  });

  test("a failed deployment returns the credits and can be tried again", async () => {
    const w = await paid({}, { deploy: "fail" });
    await uploadArtwork(w);
    await metadata(w);
    const before = w.runs[0]!.creditsSpent;
    expect((await json(w.app, "POST", "/run1/recipients", wallet("ana@x.com"))).status).toBe(502);
    expect(w.runs[0]!.creditsSpent).toBe(before);
    expect((w.runs[0]!.progress as { wallets: Record<string, unknown> }).wallets["ana@x.com"]).toBeUndefined();
  });
});

describe("issuing the certificates", () => {
  test("waits for the guests' wallets", async () => {
    const w = await withMetadata();
    expect((await json(w.app, "POST", "/run1/batches/0/build", { userAddress: OWNER })).status).toBe(409);
  });

  test("a batch mints one certificate per guest to their wallet, and completes the run", async () => {
    const w = await withWallets();
    expect((await nextOf(w)).kind).toBe("batch");
    const submitted = await sponsor(w, "batches/0");
    expect(submitted.status).toBe(200);
    const request = w.executed.at(-1) as { invoke: { typedData: { message: { Calls: { To: string; Calldata: string[] }[] } } } };
    const mints = request.invoke.typedData.message.Calls;
    expect(mints).toHaveLength(2);
    mints.forEach((mint, i) => {
      expect(BigInt(mint.To)).toBe(BigInt(REGISTRY));
      expect(BigInt(mint.Calldata[2]!)).toBe(BigInt(`0xa${i + 1}`));
      expect(mint.Calldata.slice(3, -1).map((felt) => BigInt(felt))).toEqual(encodeByteArray("ipfs://meta-1").map((felt) => BigInt(felt)));
    });

    expect((await json(w.app, "POST", "/run1/batches/0/confirm")).status).toBe(202);
    w.setReceipt("SUCCEEDED");
    const confirmed = await json(w.app, "POST", "/run1/batches/0/confirm");
    expect(((await confirmed.json()) as { data: { completed: boolean } }).data.completed).toBe(true);
    expect(w.runs[0]!.status).toBe("COMPLETED");
    expect(w.runs[0]!.creditsSpent).toBe(HELD);
    expect(w.refunds).toEqual([0]);
  });

  test("a reverted batch returns its credits and can run again", async () => {
    const w = await withWallets();
    await sponsor(w, "batches/0");
    const before = w.runs[0]!.creditsSpent;
    w.setReceipt("REVERTED");
    await json(w.app, "POST", "/run1/batches/0/confirm");
    expect(w.runs[0]!.creditsSpent).toBe(before - (PRICE * 2 + PRICE * 2));
    expect((await sponsor(w, "batches/0")).status).toBe(200);
  });

  test("a wallet from another account cannot issue", async () => {
    const w = await withWallets();
    expect((await json(w.app, "POST", "/run1/batches/0/build", { userAddress: "0xbeef" })).status).toBe(403);
  });
});

describe("cancelling", () => {
  test("refunds what was not spent, but not while a transaction is landing", async () => {
    const landing = await withWallets();
    await sponsor(landing, "batches/0");
    expect((await json(landing.app, "POST", "/run1/cancel")).status).toBe(409);

    const w = await paid();
    await uploadArtwork(w);
    const balance = w.balances.get("ac1")!;
    expect((await json(w.app, "POST", "/run1/cancel")).status).toBe(200);
    expect(w.balances.get("ac1")).toBe(balance + HELD - PRICE);
  });
});

describe("a run that creates its own collection", () => {
  const created: ReceiptEvent = { from_address: REGISTRY, keys: [COLLECTION_CREATED_SELECTOR, "0x2a", "0x0"], data: [OWNER] };

  async function newCollectionRun() {
    const w = world();
    await json(w.app, "POST", "/", {
      service: "certificate-emission",
      spec: { ...spec, collection: { kind: "new", name: "Cohort 1", symbol: "C1" } },
    });
    await json(w.app, "POST", "/run1/checkout", { method: "credits" });
    return w;
  }

  test("the collection comes first, and its id from the registry's event unlocks the rest", async () => {
    const w = await newCollectionRun();
    expect((await nextOf(w)).kind).toBe("collection");
    expect((await sponsor(w, "wallets")).status).toBe(404);

    expect((await sponsor(w, "collection")).status).toBe(200);
    expect((await sponsor(w, "collection")).status).toBe(409);
    expect((await nextOf(w)).kind).toBe("wait-collection");

    w.setReceipt("SUCCEEDED", [created]);
    const confirmed = await json(w.app, "POST", "/run1/collection/confirm");
    const { data } = (await confirmed.json()) as { data: { collectionId: string } };
    expect(data.collectionId).toBe("42");
    expect((await nextOf(w)).kind).toBe("upload");
  });

  test("the batch mints onto the new collection", async () => {
    const w = await newCollectionRun();
    await sponsor(w, "collection");
    w.setReceipt("SUCCEEDED", [created]);
    await json(w.app, "POST", "/run1/collection/confirm");
    await uploadArtwork(w);
    await metadata(w);
    for (const guest of spec.guests) await json(w.app, "POST", "/run1/recipients", wallet(guest));
    await sponsor(w, "batches/0");
    const request = w.executed.at(-1) as { invoke: { typedData: { message: { Calls: { Calldata: string[] }[] } } } };
    expect(BigInt(request.invoke.typedData.message.Calls[0]!.Calldata[0]!)).toBe(42n);
  });

  test("a run on an existing collection has no collection step", async () => {
    const w = await paid();
    expect((await json(w.app, "POST", "/run1/collection/build", { userAddress: OWNER })).status).toBe(409);
  });
});
