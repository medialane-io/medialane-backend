import { test, expect, describe } from "bun:test";
import { parseDepositEvents, creditDeposit, creditFromTransaction, type DepositDeps, type DepositEvent } from "./treasuryDeposit.js";
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
    priceAt: async () => 0.028,
    blockTimestamp: async () => new Date("2026-09-10T22:08:00Z"),
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
  blockNumber: 14677219,
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

  test("no price at that block throws, so the batch retries instead of skipping the deposit", async () => {
    let called = false;
    await expect(
      creditDeposit(deposit, deps({
        priceAt: async () => null,
        creditAccount: async () => { called = true; },
      })),
    ).rejects.toThrow();
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

describe("crediting a specific transaction on request", () => {
  const strkTransfer = {
    from_address: STRK.address,
    keys: ["0xtransfer", PAYER, TREASURY],
    data: ["0x8ac7230489e80000", "0x0"],
    transaction_hash: "0xabc",
    block_number: 1,
  } as never;

  test("a transfer in the receipt is credited", async () => {
    let credited = 0;
    const res = await creditFromTransaction(
      "0xabc",
      deps({ creditAccount: async (i) => { credited = i.creditedAmount; } }),
      async () => ({ events: [strkTransfer] }),
    );
    expect(res.credited).toBe(1);
    expect(credited).toBe(28);
  });

  test("a transaction that sent nothing to the treasury credits nothing", async () => {
    let called = false;
    const res = await creditFromTransaction(
      "0xabc",
      deps({ creditAccount: async () => { called = true; } }),
      async () => ({ events: [] }),
    );
    expect(res.credited).toBe(0);
    expect(called).toBe(false);
  });

  test("a hash a caller made up credits nothing, because the chain is read", async () => {
    let called = false;
    const res = await creditFromTransaction(
      "0xdeadbeef",
      deps({ creditAccount: async () => { called = true; } }),
      async () => ({
        events: [
          {
            from_address: STRK.address,
            keys: ["0xtransfer", PAYER, "0x0dead"],
            data: ["0x8ac7230489e80000", "0x0"],
            transaction_hash: "0xdeadbeef",
            block_number: 1,
          } as never,
        ],
      }),
    );
    expect(res.credited).toBe(0);
    expect(called).toBe(false);
  });

  test("asking twice credits once", async () => {
    let calls = 0;
    const shared = deps({
      alreadyCredited: async () => calls > 0,
      creditAccount: async () => { calls += 1; },
    });
    await creditFromTransaction("0xabc", shared, async () => ({ events: [strkTransfer] }));
    await creditFromTransaction("0xabc", shared, async () => ({ events: [strkTransfer] }));
    expect(calls).toBe(1);
  });
});

test("one unreadable event does not stop the rest being credited", () => {
  const good = {
    from_address: STRK.address,
    keys: ["0xtransfer", PAYER, TREASURY],
    data: ["0x8ac7230489e80000", "0x0"],
    transaction_hash: "0x600d",
    block_number: 1,
  } as never;
  const broken = { from_address: STRK.address, keys: ["0xtransfer", PAYER, "zzz"], data: ["0x1"], transaction_hash: "0x0bad" } as never;
  expect(parseDepositEvents([broken, good], TREASURY).length).toBe(1);
});

test("the deposit is valued at the moment it landed, not when it is read", async () => {
  let askedFor: Date | null = null;
  await creditDeposit(deposit, deps({
    blockTimestamp: async () => new Date("2026-09-10T22:08:00Z"),
    priceAt: async (_symbol, at) => { askedFor = at; return 0.028; },
  }));
  expect(askedFor!.toISOString()).toBe("2026-09-10T22:08:00.000Z");
});
