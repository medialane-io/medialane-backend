import { describe, expect, test } from "bun:test";
import type { Call } from "starknet";
import { buildCompleteEscapeOwnerCall, buildTriggerEscapeOwnerCall, computeOwnerGuid } from "@medialane/sdk/starknet";
import { completeRecovery, parseEscape, recoveryStatus, startRecovery, type EscapeState, type RecoveryDeps } from "./walletRecovery.js";

const WALLET = "0xabc";
const OLD = "0x0111";
const NEW = "0x0222";
const NONE: EscapeState = { type: "None", status: "None", readyAt: 0, newSignerKey: null };
const waiting = (key = NEW): EscapeState => ({ type: "Owner", status: "NotReady", readyAt: 1_900_000_000, newSignerKey: key });
const ready = (key = NEW): EscapeState => ({ type: "Owner", status: "Ready", readyAt: 1_800_000_000, newSignerKey: key });

function fake(over: Partial<RecoveryDeps> & { escape?: EscapeState; owners?: string[]; enabled?: boolean } = {}) {
  const state = { escape: over.escape ?? NONE, owners: over.owners ?? [computeOwnerGuid(OLD)], executed: [] as Call[][], synced: [] as string[] };
  const deps: RecoveryDeps = {
    walletOf: async () => WALLET,
    guardianIsOurs: async () => over.enabled ?? true,
    guardianPubkeyOf: () => "0x0aaa",
    ownerGuidsOf: async () => state.owners,
    escapeOf: async () => state.escape,
    execute: async ({ calls }) => {
      state.executed.push(calls);
      if (calls[0]!.entrypoint === "trigger_escape_owner") state.escape = waiting();
      if (calls[0]!.entrypoint === "escape_owner") { state.owners = [computeOwnerGuid(NEW)]; state.escape = NONE; }
      return "0xtx";
    },
    waitFor: async () => {},
    syncActivity: (walletAddress) => { state.synced.push(walletAddress); },
    ...over,
  };
  return { deps, state };
}

describe("the state of a wallet's recovery", () => {
  test("is off when the wallet has no Medialane guardian", async () => {
    const { deps } = fake({ enabled: false });
    expect(await recoveryStatus(deps, "acc")).toEqual({ status: 200, body: { enabled: false, state: "none", readyAt: null, newOwnerGuid: null, guardianPubkey: "0x0aaa" } });
  });

  test("is on with nothing in progress", async () => {
    const { deps } = fake();
    expect(await recoveryStatus(deps, "acc")).toEqual({ status: 200, body: { enabled: true, state: "none", readyAt: null, newOwnerGuid: null, guardianPubkey: null } });
  });

  test("shows the wait, and the key that is waiting", async () => {
    const { deps } = fake({ escape: waiting() });
    expect(await recoveryStatus(deps, "acc")).toEqual({
      status: 200,
      body: { enabled: true, state: "waiting", readyAt: 1_900_000_000, newOwnerGuid: computeOwnerGuid(NEW), guardianPubkey: null },
    });
  });

  test("shows when it is ready", async () => {
    const { deps } = fake({ escape: ready() });
    expect(await recoveryStatus(deps, "acc")).toMatchObject({ status: 200, body: { state: "ready", readyAt: 1_800_000_000 } });
  });

  test("an account with no wallet is not found", async () => {
    const { deps } = fake({ walletOf: async () => null });
    expect((await recoveryStatus(deps, "acc")).status).toBe(404);
  });
});

describe("starting a recovery", () => {
  test("names the new key with one guardian-signed call and returns the wait", async () => {
    const { deps, state } = fake();
    const outcome = await startRecovery(deps, "acc", NEW);
    expect(state.executed).toEqual([[buildTriggerEscapeOwnerCall(WALLET, NEW)]]);
    expect(outcome).toEqual({ status: 200, body: { enabled: true, state: "waiting", readyAt: 1_900_000_000, newOwnerGuid: computeOwnerGuid(NEW), guardianPubkey: null } });
  });

  test("refuses a wallet without our guardian and sends nothing", async () => {
    const { deps, state } = fake({ enabled: false });
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(409);
    expect(state.executed).toEqual([]);
  });

  test("a key that already owns the wallet needs no recovery", async () => {
    const { deps, state } = fake({ owners: [computeOwnerGuid(OLD), computeOwnerGuid(NEW)] });
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(200);
    expect(state.executed).toEqual([]);
  });

  test("asking again for the same key changes nothing", async () => {
    const { deps, state } = fake({ escape: waiting() });
    const outcome = await startRecovery(deps, "acc", NEW);
    expect(outcome.status).toBe(200);
    expect(state.executed).toEqual([]);
  });

  test("a recovery waiting for another key is replaced by the newest one, so a lost browser never blocks a retry", async () => {
    const { deps, state } = fake({ escape: waiting("0x0999") });
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(200);
    expect(state.executed).toEqual([[buildTriggerEscapeOwnerCall(WALLET, NEW)]]);
  });

  test("the owner's own guardian removal in progress is not overridden", async () => {
    const { deps, state } = fake({ escape: { type: "Guardian", status: "NotReady", readyAt: 1_900_000_000, newSignerKey: null } });
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(409);
    expect(state.executed).toEqual([]);
  });

  test("an expired recovery can be started again", async () => {
    const { deps, state } = fake({ escape: { ...waiting(), status: "Expired" } });
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(200);
    expect(state.executed).toHaveLength(1);
  });

  test("a failed submission is reported and nothing is claimed", async () => {
    const { deps } = fake({ execute: async () => { throw new Error("sponsor down"); } });
    expect(await startRecovery(deps, "acc", NEW)).toMatchObject({ status: 502 });
  });

  test("a failed submission does not pass the underlying error text on", async () => {
    const { deps } = fake({ execute: async () => { throw new Error("boom https://x.example/k"); } });
    expect(await startRecovery(deps, "acc", NEW)).toEqual({ status: 502, error: "The recovery could not be sent" });
  });
});

describe("completing a recovery", () => {
  test("finishes it for the waiting key, once the wait is over", async () => {
    const { deps, state } = fake({ escape: ready() });
    expect(await completeRecovery(deps, "acc", NEW)).toEqual({ status: 200, body: { enabled: true, state: "none", readyAt: null, newOwnerGuid: null, guardianPubkey: null } });
    expect(state.executed).toEqual([[buildCompleteEscapeOwnerCall(WALLET)]]);
    expect(state.owners).toEqual([computeOwnerGuid(NEW)]);
  });

  test("is refused while the wait is not over", async () => {
    const { deps, state } = fake({ escape: waiting() });
    expect((await completeRecovery(deps, "acc", NEW)).status).toBe(409);
    expect(state.executed).toEqual([]);
  });

  test("is refused for a key other than the one that is waiting", async () => {
    const { deps, state } = fake({ escape: ready("0x0999") });
    expect((await completeRecovery(deps, "acc", NEW)).status).toBe(409);
    expect(state.executed).toEqual([]);
  });

  test("is refused when nothing is in progress", async () => {
    const { deps, state } = fake();
    expect((await completeRecovery(deps, "acc", NEW)).status).toBe(409);
    expect(state.executed).toEqual([]);
  });

  test("is reported as failed when the key is still not an owner afterwards", async () => {
    const { deps } = fake({ escape: ready(), execute: async () => "0xtx" });
    expect((await completeRecovery(deps, "acc", NEW)).status).toBe(502);
  });
});

describe("the wallet's activity is refreshed after a recovery changes on chain", () => {
  test("starting a recovery queues one activity sync for the wallet", async () => {
    const { deps, state } = fake();
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(200);
    expect(state.synced).toEqual([WALLET]);
  });

  test("completing a recovery queues one activity sync", async () => {
    const { deps, state } = fake({ escape: ready() });
    expect((await completeRecovery(deps, "acc", NEW)).status).toBe(200);
    expect(state.synced).toEqual([WALLET]);
  });

  test("an existing recovery for this key queues no sync", async () => {
    const { deps, state } = fake({ escape: waiting() });
    expect((await startRecovery(deps, "acc", NEW)).status).toBe(200);
    expect(state.synced).toEqual([]);
  });

  test("a refused start queues no sync", async () => {
    const guardianEscape = fake({ escape: { type: "Guardian", status: "NotReady", readyAt: 1, newSignerKey: null } });
    expect((await startRecovery(guardianEscape.deps, "acc", NEW)).status).toBe(409);
    const failed = fake({ execute: async () => { throw new Error("refused"); } });
    expect((await startRecovery(failed.deps, "acc", NEW)).status).toBe(502);
    expect([...guardianEscape.state.synced, ...failed.state.synced]).toEqual([]);
  });
});

describe("reading the wallet's escape from the chain", () => {
  test("a recovery waiting for a key, as the real wallet returns it", () => {
    expect(parseEscape(["0x6aeba013", "0x2", "0x0", "0x50071ad45b594ab7c55ae84cbf3c1e28d24b05172d14c8964d869748353d909", "0x0", "0x1"])).toEqual({
      type: "Owner",
      status: "NotReady",
      readyAt: 0x6aeba013,
      newSignerKey: "0x50071ad45b594ab7c55ae84cbf3c1e28d24b05172d14c8964d869748353d909",
    });
  });

  test("no escape", () => {
    expect(parseEscape(["0x0", "0x0", "0x1", "0x0"])).toEqual({ type: "None", status: "None", readyAt: 0, newSignerKey: null });
  });

  test("a guardian escape names no new owner", () => {
    expect(parseEscape(["0x10", "0x1", "0x1", "0x2"])).toMatchObject({ type: "Guardian", status: "Ready", newSignerKey: null });
  });
});
