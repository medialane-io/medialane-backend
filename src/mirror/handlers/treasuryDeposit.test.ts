import { test, expect, describe } from "bun:test";
import { parseDepositEvents, creditDeposit, type DepositDeps, type DepositEvent } from "./treasuryDeposit.js";
import { acceptedTokens } from "../../payments/token-value.js";

const TREASURY = "0x064c51746dbcb7498cc6e4b8abfcacd60805c0762b0411bb0515c611b5ae8223";
const PAYER = "0x000c9";
const STRK = acceptedTokens().find((t) => t.symbol === "STRK")!;
const ETH = acceptedTokens().find((t) => t.symbol === "ETH")!;

function transfer(over: Partial<{ token: string; to: string; from: string; low: string; tx: string }> = {}) {
  return {
    from_address: over.token ?? STRK.address,
    keys: ["0xtransfer", over.from ?? PAYER, over.to ?? TREASURY],
    data: [over.low ?? "0x8ac7230489e80000", "0x0"],
    transaction_hash: over.tx ?? "0xabc",
    block_number: 1,
  } as never;
}

describe("reading deposits from events", () => {
  test("a transfer to the treasury is a deposit", () => {
    const [d] = parseDepositEvents([transfer()], TREASURY);
    expect(d.amountAtomic).toBe(10n * 10n ** 18n);
    expect(BigInt(d.payer)).toBe(BigInt(PAYER));
  });

  test("a transfer to someone else is ignored", () => {
    expect(parseDepositEvents([transfer({ to: "0xdead" })], TREASURY)).toEqual([]);
  });

  test("a token we do not accept is ignored", () => {
    expect(parseDepositEvents([transfer({ token: "0xdead" })], TREASURY)).toEqual([]);
  });

  test("a zero transfer is ignored", () => {
    expect(parseDepositEvents([transfer({ low: "0x0" })], TREASURY)).toEqual([]);
  });

  test("an unpadded treasury address still matches", () => {
    const unpadded = "0x" + TREASURY.replace(/^0x0*/, "");
    expect(parseDepositEvents([transfer({ to: unpadded })], TREASURY).length).toBe(1);
  });

  test("several deposits in one batch are all read", () => {
    const events = [transfer({ tx: "0x1" }), transfer({ tx: "0x2", token: ETH.address })];
    expect(parseDepositEvents(events, TREASURY).length).toBe(2);
  });
});

function deps(over: Partial<DepositDeps> = {}): DepositDeps {
  return {
    resolveApiClient: async () => ({ id: "client-1", accountId: "acct-1" }),
    alreadyCredited: async () => false,
    readUsdPrices: async () => ({ STRK: 0.028 }),
    mdlnMultiplier: async () => 1,
    creditAccount: async () => {},
    ...over,
  };
}

const deposit: DepositEvent = {
  txHash: "0xabc",
  token: STRK.address,
  amountAtomic: 10n * 10n ** 18n,
  payer: PAYER,
};

describe("crediting a deposit", () => {
  test("ten STRK credits at its dollar value", async () => {
    let credited = 0;
    await creditDeposit(deposit, deps({ creditAccount: async (i) => { credited = i.creditedAmount; } }));
    expect(credited).toBe(28);
  });

  test("a deposit already in the ledger is not credited twice", async () => {
    let called = false;
    await creditDeposit(deposit, deps({
      alreadyCredited: async () => true,
      creditAccount: async () => { called = true; },
    }));
    expect(called).toBe(false);
  });

  test("a wallet with no api client is left uncredited", async () => {
    let called = false;
    await creditDeposit(deposit, deps({
      resolveApiClient: async () => null,
      creditAccount: async () => { called = true; },
    }));
    expect(called).toBe(false);
  });

  test("no price leaves the deposit for a later pass rather than crediting wrongly", async () => {
    let called = false;
    await creditDeposit(deposit, deps({
      readUsdPrices: async () => ({}),
      creditAccount: async () => { called = true; },
    }));
    expect(called).toBe(false);
  });

  test("an MDLN holder is credited their bonus", async () => {
    let credited = 0;
    await creditDeposit(deposit, deps({
      mdlnMultiplier: async () => 1.5,
      creditAccount: async (i) => { credited = i.creditedAmount; },
    }));
    expect(credited).toBe(42);
  });

  test("the payment records the token actually sent", async () => {
    let asset = "";
    await creditDeposit(deposit, deps({ creditAccount: async (i) => { asset = i.asset; } }));
    expect(BigInt(asset)).toBe(BigInt(STRK.address));
  });

  test("the transaction hash is the proof, so a replay cannot double credit", async () => {
    let nonce = "";
    await creditDeposit(deposit, deps({ creditAccount: async (i) => { nonce = i.proofNonce; } }));
    expect(nonce).toBe("0xabc");
  });
});
