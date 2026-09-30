import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createFundingRoutes } from "./portal-funding.js";
import type { FundingIntentRecord, FundingMethod, FundingStore, SettleOutcome } from "../../funding/types.js";

function fakeMethod(over: Partial<FundingMethod> = {}): FundingMethod {
  return {
    id: "chain-transfer",
    available: () => true,
    describe: () => ({ asset: "USDC" }),
    parseParams: (raw) => (raw && (raw as any).amountUsdc ? { ok: true, params: { amountAtomic: "1000000" } } : { ok: false, error: "bad amount" }),
    challenge: () => ({ ok: true, typedData: { primaryType: "FundingIntent" } }),
    authorize: async () => ({ ok: true, payer: "0xpayer", instructions: { payTo: "0xtreasury" } }),
    verify: async () => ({
      ok: true,
      payment: { valueUsdcAtomic: 1_000_000n, asset: "0xusdc", payer: "0xpayer", proofNonce: "0xh", scheme: "starknet-transfer", network: "starknet", txHash: "0xh" },
    }),
    ...over,
  };
}

function makeStore(intents: FundingIntentRecord[] = [], over: Partial<FundingStore> = {}): FundingStore {
  return {
    create: async (i) => {
      const made: FundingIntentRecord = { id: "fi1", apiClientId: i.apiClientId, method: i.method, status: "PENDING", payer: null, params: i.params, expiresAt: i.expiresAt };
      intents.push(made);
      return made;
    },
    get: async (id, apiClientId) => intents.find((i) => i.id === id && i.apiClientId === apiClientId) ?? null,
    setPayer: async (id, _c, payer) => {
      const found = intents.find((i) => i.id === id);
      if (!found || found.payer) return false;
      found.payer = payer;
      return true;
    },
    openForPayer: async () => [],
    cancel: async () => true,
    settle: async (): Promise<SettleOutcome> => ({ outcome: "settled", paymentId: "pay1" }),
    ...over,
  };
}

function app(store: FundingStore, methods: FundingMethod[] = [fakeMethod()], apiClientId = "ac1") {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "a1", status: "ACTIVE" });
    c.set("apiClient", { id: apiClientId, accountId: "a1", plan: "FREE", creditBalance: 0 });
    await next();
  });
  a.route("/", createFundingRoutes({ store, methods, mdlnMultiplier: async () => 1 }));
  return a;
}

const post = (a: Hono<AppEnv>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("funding methods", () => {
  test("lists only the methods that are available", async () => {
    const a = app(makeStore(), [fakeMethod(), fakeMethod({ id: "card", available: () => false })]);
    const body = await (await a.request("/methods")).json();
    expect(body.data.map((m: any) => m.id)).toEqual(["chain-transfer"]);
  });
});

describe("starting a top-up", () => {
  test("creates an intent for the signed-in account", async () => {
    const intents: FundingIntentRecord[] = [];
    const res = await post(app(makeStore(intents)), "/", { method: "chain-transfer", params: { amountUsdc: "5" } });
    expect(res.status).toBe(201);
    expect(intents[0]!.apiClientId).toBe("ac1");
  });

  test("an unknown or unavailable method is a 404", async () => {
    expect((await post(app(makeStore()), "/", { method: "nope", params: {} })).status).toBe(404);
    const off = app(makeStore(), [fakeMethod({ available: () => false })]);
    expect((await post(off, "/", { method: "chain-transfer", params: { amountUsdc: "5" } })).status).toBe(404);
  });

  test("bad parameters are a 400 with the method's message", async () => {
    const res = await post(app(makeStore()), "/", { method: "chain-transfer", params: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad amount");
  });

  test("a top-up is created however many are already open", async () => {
    const res = await post(app(makeStore([])), "/", { method: "chain-transfer", params: { amountUsdc: "5" } });
    expect(res.status).toBe(201);
  });

  test("the caller cannot name the account or an amount to credit", async () => {
    const intents: FundingIntentRecord[] = [];
    await post(app(makeStore(intents)), "/", { method: "chain-transfer", params: { amountUsdc: "5" }, apiClientId: "victim", credits: 9999 });
    expect(intents[0]!.apiClientId).toBe("ac1");
  });
});

describe("authorizing and paying", () => {
  const open = (over: Partial<FundingIntentRecord> = {}): FundingIntentRecord => ({
    id: "fi1", apiClientId: "ac1", method: "chain-transfer", status: "PENDING", payer: null, params: { amountAtomic: "1000000" }, expiresAt: new Date(Date.now() + 60_000), ...over,
  });

  test("challenge returns what to sign", async () => {
    const res = await post(app(makeStore([open()])), "/fi1/challenge", { payer: "0xpayer" });
    expect((await res.json()).data.typedData.primaryType).toBe("FundingIntent");
  });

  test("another account's intent looks like it does not exist", async () => {
    const res = await post(app(makeStore([open({ apiClientId: "other" })])), "/fi1/challenge", { payer: "0xpayer" });
    expect(res.status).toBe(404);
  });

  test("authorize stores the payer and returns the instructions", async () => {
    const intents = [open()];
    const res = await post(app(makeStore(intents)), "/fi1/authorize", { payer: "0xpayer", signature: ["0x1"] });
    expect(res.status).toBe(200);
    expect(intents[0]!.payer).toBe("0xpayer");
  });

  test("authorizing twice is a 409", async () => {
    const intents = [open()];
    const a = app(makeStore(intents));
    await post(a, "/fi1/authorize", { payer: "0xpayer", signature: ["0x1"] });
    const second = await post(a, "/fi1/authorize", { payer: "0xattacker", signature: ["0x1"] });
    expect(second.status).toBe(409);
    expect(intents[0]!.payer).toBe("0xpayer");
  });

  test("a refused signature is a 400 and stores nothing", async () => {
    const intents = [open()];
    const a = app(makeStore(intents), [fakeMethod({ authorize: async () => ({ ok: false, error: "bad signature" }) })]);
    expect((await post(a, "/fi1/authorize", { payer: "0xpayer", signature: ["0x1"] })).status).toBe(400);
    expect(intents[0]!.payer).toBeNull();
  });

  test("submit credits the account and reports the credits", async () => {
    const res = await post(app(makeStore([open({ payer: "0xpayer" })])), "/fi1/submit", { txHash: "0xh" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: "SETTLED", credited: 100 });
  });

  test("a transfer that is not confirmed yet is a 202, not an error", async () => {
    const a = app(makeStore([open({ payer: "0xpayer" })]), [fakeMethod({ verify: async () => ({ ok: false, reason: "not in a block yet, try again" }) })]);
    const res = await post(a, "/fi1/submit", { txHash: "0xh" });
    expect(res.status).toBe(202);
    expect((await res.json()).data.status).toBe("PENDING");
  });

  test("submitting for an intent with no payer is a 409", async () => {
    expect((await post(app(makeStore([open()])), "/fi1/submit", { txHash: "0xh" })).status).toBe(409);
  });

  test("submitting again for an intent that is already settled reports it as settled, so a retry after a lost response is harmless", async () => {
    let settleCalls = 0;
    const s = makeStore([open({ payer: "0xpayer", status: "SETTLED" })], { settle: async () => { settleCalls++; return { outcome: "settled", paymentId: "x" }; } });
    const res = await post(app(s), "/fi1/submit", { txHash: "0xh" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("SETTLED");
    expect(settleCalls).toBe(0);
  });

  test("submitting for an intent that failed or expired is a 409", async () => {
    expect((await post(app(makeStore([open({ payer: "0xpayer", status: "EXPIRED" })])), "/fi1/submit", { txHash: "0xh" })).status).toBe(409);
    expect((await post(app(makeStore([open({ payer: "0xpayer", status: "FAILED" })])), "/fi1/submit", { txHash: "0xh" })).status).toBe(409);
  });

  test("a transfer already credited elsewhere does not credit twice", async () => {
    const s = makeStore([open({ payer: "0xpayer" })], { settle: async () => ({ outcome: "duplicate" }) });
    const res = await post(app(s), "/fi1/submit", { txHash: "0xh" });
    expect(res.status).toBe(409);
  });
});

describe("cancelling a top-up", () => {
  const open = (over: Partial<FundingIntentRecord> = {}): FundingIntentRecord => ({
    id: "fi1", apiClientId: "ac1", method: "chain-transfer", status: "PENDING", payer: "0xpayer", params: { amountAtomic: "1000000" }, expiresAt: new Date(Date.now() + 60_000), ...over,
  });

  test("closes an open top-up so it stops counting and matching", async () => {
    let cancelled = 0;
    const s = makeStore([open()], { cancel: async () => { cancelled++; return true; } });
    const res = await post(app(s), "/fi1/cancel", {});
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("EXPIRED");
    expect(cancelled).toBe(1);
  });

  test("cancelling again reports the state it is already in", async () => {
    const s = makeStore([open({ status: "EXPIRED" })]);
    const res = await post(app(s), "/fi1/cancel", {});
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("EXPIRED");
  });

  test("a paid top-up cannot be cancelled", async () => {
    const res = await post(app(makeStore([open({ status: "SETTLED" })])), "/fi1/cancel", {});
    expect(res.status).toBe(409);
  });

  test("losing a race to a settlement is a 409, not a false cancel", async () => {
    const intents = [open()];
    const s = makeStore(intents, { cancel: async () => { intents[0]!.status = "SETTLED"; return false; } });
    const res = await post(app(s), "/fi1/cancel", {});
    expect(res.status).toBe(409);
  });

  test("another account's top-up looks like it does not exist", async () => {
    const res = await post(app(makeStore([open({ apiClientId: "other" })])), "/fi1/cancel", {});
    expect(res.status).toBe(404);
  });
});
