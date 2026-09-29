import { describe, expect, test } from "bun:test";
import { parseDepositEvents, TRANSFER_SELECTOR } from "./deposits.js";
import { acceptedTokens } from "../payments/token-value.js";

const TREASURY = "0x064c51746dbcb7498cc6e4b8abfcacd60805c0762b0411bb0515c611b5ae8223";
const PAYER = "0x000c9";
const USDC = acceptedTokens().find((t) => t.symbol === "USDC")!;
const APPROVAL = "0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff";

function event(selector: string) {
  return {
    from_address: USDC.address,
    keys: [selector, PAYER, TREASURY],
    data: ["0xf4240", "0x0"],
    transaction_hash: "0xabc",
    block_number: 1,
  } as never;
}

describe("only Transfer events are deposits", () => {
  test("a Transfer to the treasury is a deposit", () => {
    const [d] = parseDepositEvents([event("0x" + TRANSFER_SELECTOR.toString(16))], TREASURY);
    expect(d.amountAtomic).toBe(1_000_000n);
  });

  test("an Approval naming the treasury as spender is not a deposit", () => {
    expect(parseDepositEvents([event(APPROVAL)], TREASURY)).toEqual([]);
  });

  test("an event with no selector is not a deposit", () => {
    const ev = { ...(event(APPROVAL) as object), keys: [] } as never;
    expect(parseDepositEvents([ev], TREASURY)).toEqual([]);
  });
});
