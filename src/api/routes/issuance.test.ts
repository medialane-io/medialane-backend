import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import {
  createIssuanceRoutes,
  chunk,
  dedupeRecipients,
  serviceCanMint,
  normalizeRecipientValue,
  type IssuanceDeps,
  type Call,
} from "./issuance.js";

function makeApp(deps: IssuanceDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acc-1", status: "ACTIVE" });
    c.set("apiClient", { id: "biz-1", accountId: "acc-1", plan: "FREE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/business/issuance", createIssuanceRoutes(deps));
  return app;
}

function fakeDeps(overrides: Partial<IssuanceDeps> = {}): IssuanceDeps {
  return {
    resolveWallets: async (_chain, _scheme, values) =>
      values.map((value, i) => ({ recipientValue: value, walletAddress: `0x${i + 1}` })),
    buildMintCalls: async (input) => [
      { contractAddress: "0xcol", entrypoint: "mint", calldata: [input.recipient, input.tokenUri] },
    ],
    ...overrides,
  };
}

function post(app: Hono<AppEnv>, body: unknown) {
  return app.request("/v1/business/issuance/mint-calls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseBody = {
  service: "ip-erc721",
  owner: "0xb12",
  tokenUri: "ipfs://asset",
  collectionId: "1",
  recipients: ["a@example.com", "b@example.com"],
};

describe("chunk", () => {
  test("splits into batches of the requested size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("returns one batch when everything fits", () => {
    expect(chunk([1, 2], 25)).toEqual([[1, 2]]);
  });

  test("returns no batches for no items", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  test("refuses a batch size below one", () => {
    expect(() => chunk([1], 0)).toThrow("batch size must be at least 1");
  });
});

describe("recipients", () => {
  test("emails are compared case-insensitively", () => {
    expect(normalizeRecipientValue("email", " A@Example.COM ")).toBe("a@example.com");
  });

  test("a repeated recipient is issued to once", () => {
    expect(dedupeRecipients("email", ["a@x.com", "A@X.com", "b@x.com"])).toEqual(["a@x.com", "b@x.com"]);
  });

  test("blank entries are dropped", () => {
    expect(dedupeRecipients("email", ["a@x.com", "   ", ""])).toEqual(["a@x.com"]);
  });

  test("order of the submitted list is preserved", () => {
    expect(dedupeRecipients("email", ["c@x.com", "a@x.com", "b@x.com"])).toEqual([
      "c@x.com",
      "a@x.com",
      "b@x.com",
    ]);
  });

  test("non-email schemes keep their original case", () => {
    expect(normalizeRecipientValue("wallet", " 0xAbC ")).toBe("0xAbC");
  });
});

describe("service gating", () => {
  test("a service that mints is allowed", () => {
    expect(serviceCanMint("ip-erc721")).toBe(true);
  });

  test("a marketplace service cannot issue", () => {
    expect(serviceCanMint("medialane-marketplace-erc721")).toBe(false);
  });

  test("an unknown service cannot issue", () => {
    expect(serviceCanMint("not-a-service")).toBe(false);
  });

  test("the route rejects a service without mint", async () => {
    const res = await post(makeApp(fakeDeps()), { ...baseBody, service: "medialane-marketplace-erc721" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("service_cannot_mint");
  });
});

describe("mint-calls", () => {
  test("builds one call per recipient", async () => {
    const res = await post(makeApp(fakeDeps()), baseBody);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(2);
    expect(data.callCount).toBe(2);
  });

  test("each call targets that recipient's own wallet", async () => {
    const res = await post(makeApp(fakeDeps()), baseBody);
    const { data } = await res.json();
    const recipients = data.batches.flat().map((call: Call) => call.calldata[0]);
    expect(recipients).toEqual(["0x1", "0x2"]);
  });

  test("calls are split into signable batches", async () => {
    const recipients = Array.from({ length: 7 }, (_, i) => `u${i}@x.com`);
    const res = await post(makeApp(fakeDeps()), { ...baseBody, recipients, batchSize: 3 });
    const { data } = await res.json();
    expect(data.batches.map((b: Call[]) => b.length)).toEqual([3, 3, 1]);
  });

  test("a duplicated recipient is not issued to twice", async () => {
    const res = await post(makeApp(fakeDeps()), {
      ...baseBody,
      recipients: ["a@x.com", "A@X.com"],
    });
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1);
    expect(data.callCount).toBe(1);
  });

  test("stops when a recipient has no wallet yet", async () => {
    const deps = fakeDeps({
      resolveWallets: async (_chain, _scheme, values) =>
        values.map((value, i) => ({ recipientValue: value, walletAddress: i === 0 ? "0x1" : null })),
    });
    const res = await post(makeApp(deps), baseBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("recipients_not_provisioned");
    expect(body.recipients).toEqual(["b@example.com"]);
  });

  test("issues nothing when no recipient is provisioned", async () => {
    const deps = fakeDeps({
      resolveWallets: async (_chain, _scheme, values) =>
        values.map((value) => ({ recipientValue: value, walletAddress: null })),
    });
    const res = await post(makeApp(deps), baseBody);
    expect(res.status).toBe(409);
  });

  test("requires a collection to mint into", async () => {
    const { collectionId, ...withoutCollection } = baseBody;
    const res = await post(makeApp(fakeDeps()), withoutCollection);
    expect(res.status).toBe(400);
  });

  test("refuses a recipient list beyond the cap", async () => {
    const recipients = Array.from({ length: 501 }, (_, i) => `u${i}@x.com`);
    const res = await post(makeApp(fakeDeps()), { ...baseBody, recipients });
    expect(res.status).toBe(400);
  });

  test("the business wallet is the owner on every call", async () => {
    let seenOwner = "";
    const deps = fakeDeps({
      buildMintCalls: async (input) => {
        seenOwner = input.owner;
        return [{ contractAddress: "0xcol", entrypoint: "mint", calldata: [input.recipient] }];
      },
    });
    await post(makeApp(deps), baseBody);
    expect(seenOwner).not.toBe("");
    expect(BigInt(seenOwner)).toBe(BigInt("0xb12"));
  });
});

describe("registry routing", () => {
  test("Data Tokenization mints into its own registry", async () => {
    let seen: string | undefined;
    const deps = fakeDeps({
      buildMintCalls: async (input) => {
        seen = input.collectionContract;
        return [{ contractAddress: "0xcol", entrypoint: "mint", calldata: [input.recipient] }];
      },
    });
    await post(makeApp(deps), { ...baseBody, service: "data-tokenization-erc721" });
    expect(seen).toBe("0x07421b4442f7f2052c65408fb3561484154cf8175a0bbb41e3cd38d9087af6d2");
  });

  test("an explicit collection contract still wins", async () => {
    let seen: string | undefined;
    const deps = fakeDeps({
      buildMintCalls: async (input) => {
        seen = input.collectionContract;
        return [{ contractAddress: "0xcol", entrypoint: "mint", calldata: [input.recipient] }];
      },
    });
    await post(makeApp(deps), {
      ...baseBody,
      service: "data-tokenization-erc721",
      collectionContract: "0xabc",
    });
    expect(seen).toBe("0xabc");
  });

  test("a service with no registry of its own passes nothing", async () => {
    let seen: string | undefined = "unset";
    const deps = fakeDeps({
      buildMintCalls: async (input) => {
        seen = input.collectionContract;
        return [{ contractAddress: "0xcol", entrypoint: "mint", calldata: [input.recipient] }];
      },
    });
    await post(makeApp(deps), { ...baseBody, service: "ip-erc721" });
    expect(seen).toBeUndefined();
  });
});
