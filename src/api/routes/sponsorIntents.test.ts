import { describe, expect, test } from "bun:test";
import { composeIntentCalls, type SponsorIntentDeps, type SponsorIntentRow } from "./sponsorIntents.js";

const W = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const X = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
const call = (n: string) => ({ contractAddress: "0x1", entrypoint: n, calldata: [] as string[] });
const future = new Date(Date.now() + 60_000);

function deps(rows: SponsorIntentRow[]): SponsorIntentDeps {
  return {
    load: async (ids) => rows.filter((r) => ids.includes(r.id)),
    claim: async () => true,
    release: async () => {},
    record: async () => {},
    known: async (addresses) => new Set(addresses.filter((a) => BigInt(a) === 1n)),
    now: () => new Date(),
  };
}

const row = (over: Partial<SponsorIntentRow>): SponsorIntentRow => ({
  id: "i1", type: "TRANSFER_TOKEN", accountId: "app", requester: W, status: "SIGNED", expiresAt: future, calls: [call("a")], ...over,
});

describe("composeIntentCalls", () => {
  test("composes stored calls in the given order", async () => {
    const out = await composeIntentCalls(["i2", "i1"], { accountId: "app", wallet: W },
      deps([row({ id: "i1", calls: [call("a")] }), row({ id: "i2", calls: [call("b"), call("c")] })]));
    expect(out).toEqual({ ok: true, calls: [call("b"), call("c"), call("a")] });
  });

  test("refuses an intent created through another app's key", async () => {
    const out = await composeIntentCalls(["i1"], { accountId: "app", wallet: W }, deps([row({ accountId: "other-app" })]));
    expect(out.ok).toBe(false);
  });

  test("refuses an intent whose requester is another wallet", async () => {
    const out = await composeIntentCalls(["i1"], { accountId: "app", wallet: X }, deps([row({})]));
    expect(out.ok).toBe(false);
  });

  test("refuses an expired or already sponsored intent", async () => {
    expect((await composeIntentCalls(["i1"], { accountId: "app", wallet: W }, deps([row({ expiresAt: new Date(0) })]))).ok).toBe(false);
    expect((await composeIntentCalls(["i1"], { accountId: "app", wallet: W }, deps([row({ status: "SUBMITTED" })]))).ok).toBe(false);
  });

  test("refuses unknown, empty or repeated ids", async () => {
    expect((await composeIntentCalls(["nope"], { accountId: "app", wallet: W }, deps([]))).ok).toBe(false);
    expect((await composeIntentCalls([], { accountId: "app", wallet: W }, deps([]))).ok).toBe(false);
    expect((await composeIntentCalls(["i1", "i1"], { accountId: "app", wallet: W }, deps([row({})]))).ok).toBe(false);
  });
});

describe("only known contracts are sponsored", () => {
  const unknownCall = { contractAddress: "0x666", entrypoint: "claim", calldata: [] as string[] };

  test("a call to a contract Medialane doesn't know is unavailable for sponsorship", async () => {
    const out = await composeIntentCalls(["i1"], { accountId: "app", wallet: W }, deps([row({ calls: [unknownCall] })]));
    expect(out).toEqual({ ok: false, unavailable: true, error: "These actions can't be sponsored" });
  });

  test("swap calls built from the AVNU quote are trusted, but the approved token must be known", async () => {
    const router = { contractAddress: "0x777", entrypoint: "multi_route_swap", calldata: [] as string[] };
    const knownApprove = { contractAddress: "0x1", entrypoint: "approve", calldata: [] as string[] };
    const unknownApprove = { contractAddress: "0x666", entrypoint: "approve", calldata: [] as string[] };
    expect((await composeIntentCalls(["i1"], { accountId: "app", wallet: W }, deps([row({ type: "SWAP", calls: [knownApprove, router] })]))).ok).toBe(true);
    expect((await composeIntentCalls(["i1"], { accountId: "app", wallet: W }, deps([row({ type: "SWAP", calls: [unknownApprove, router] })]))).ok).toBe(false);
  });
});

test("a large cart is composed as one sponsored transaction", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row({ id: `c${i}`, calls: [call(`f${i}`)] }));
  const out = await composeIntentCalls(rows.map((r) => r.id), { accountId: "app", wallet: W }, deps(rows));
  expect(out.ok).toBe(true);
});
