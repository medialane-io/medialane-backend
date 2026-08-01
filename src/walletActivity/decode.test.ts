import { describe, expect, test } from "bun:test";
import { decodeTransferLeg, decodeAccountEvent, pairSwapLegs, type TransferLeg } from "./decode.js";
import {
  TRANSFER_SELECTOR, ACCOUNT_CREATED_GUID_SELECTOR, GUARDIAN_ADDED_GUID_SELECTOR,
  ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR, OWNER_ESCAPED_GUID_SELECTOR, ESCAPE_CANCELED_SELECTOR,
} from "../config/constants.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const FROM = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TO = "0x0000000000000000000000000000000000000000000000000000000000000002";
const TOKEN = "0x0000000000000000000000000000000000000000000000000000000000000abc";

function baseEvent(overrides: Partial<RawStarknetEvent> = {}): RawStarknetEvent {
  return {
    block_hash: "0xblock", block_number: 100, transaction_hash: "0xtx",
    from_address: TOKEN, keys: [], data: [], ...overrides,
  };
}

describe("decodeTransferLeg", () => {
  test("decodes a standard ERC-20 Transfer event", () => {
    const event = baseEvent({
      keys: [TRANSFER_SELECTOR, FROM, TO],
      data: ["0x64", "0x0"],
    });
    const leg = decodeTransferLeg(event, TOKEN);
    expect(leg).toEqual({
      tokenAddress: TOKEN, from: FROM, to: TO, amount: "100",
      txHash: "0xtx", blockNumber: 100n,
    });
  });

  test("returns null for a non-Transfer event", () => {
    const event = baseEvent({ keys: ["0xnotTransfer", FROM, TO], data: ["0x1", "0x0"] });
    expect(decodeTransferLeg(event, TOKEN)).toBeNull();
  });
});

describe("decodeAccountEvent", () => {
  test("decodes AccountCreatedGuid as DEPLOY", () => {
    const event = baseEvent({ keys: [ACCOUNT_CREATED_GUID_SELECTOR, "0xownerguid"], data: ["0xguardianguid"] });
    expect(decodeAccountEvent(event)).toEqual({ type: "DEPLOY" });
  });

  test("decodes GuardianAddedGuid as GUARDIAN_SET", () => {
    const event = baseEvent({ keys: [GUARDIAN_ADDED_GUID_SELECTOR, "0xguardianguid"], data: [] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_SET" });
  });

  test("decodes EscapeOwnerTriggeredGuid as GUARDIAN_TRIGGER_ESCAPE", () => {
    const event = baseEvent({ keys: [ESCAPE_OWNER_TRIGGERED_GUID_SELECTOR], data: ["0x1234", "0xownerguid"] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_TRIGGER_ESCAPE" });
  });

  test("decodes OwnerEscapedGuid as GUARDIAN_COMPLETE_ESCAPE", () => {
    const event = baseEvent({ keys: [OWNER_ESCAPED_GUID_SELECTOR], data: ["0xownerguid"] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_COMPLETE_ESCAPE" });
  });

  test("decodes EscapeCanceled as GUARDIAN_CANCEL_ESCAPE", () => {
    const event = baseEvent({ keys: [ESCAPE_CANCELED_SELECTOR], data: [] });
    expect(decodeAccountEvent(event)).toEqual({ type: "GUARDIAN_CANCEL_ESCAPE" });
  });

  test("returns null for an unrecognized selector", () => {
    expect(decodeAccountEvent(baseEvent({ keys: ["0xsomethingelse"] }))).toBeNull();
  });
});

describe("pairSwapLegs", () => {
  const ACCOUNT = FROM;
  const TOKEN_B = "0x0000000000000000000000000000000000000000000000000000000000000def";

  function leg(overrides: Partial<TransferLeg>): TransferLeg {
    return { tokenAddress: TOKEN, from: ACCOUNT, to: TO, amount: "100", txHash: "0xtx1", blockNumber: 100n, ...overrides };
  }

  test("pairs an outbound + inbound leg on different tokens in the same tx into a swap", () => {
    const out = leg({ tokenAddress: TOKEN, from: ACCOUNT, to: "0xrouter", amount: "100" });
    const inn = leg({ tokenAddress: TOKEN_B, from: "0xrouter", to: ACCOUNT, amount: "50" });
    const { swaps, remaining } = pairSwapLegs([out, inn], ACCOUNT);
    expect(remaining).toHaveLength(0);
    expect(swaps).toEqual([{
      txHash: "0xtx1", blockNumber: 100n,
      tokenInAddress: TOKEN, amountIn: "100",
      tokenOutAddress: TOKEN_B, amountOut: "50",
    }]);
  });

  test("a lone outbound leg (no matching inbound in the same tx) stays a plain transfer", () => {
    const out = leg({ tokenAddress: TOKEN, from: ACCOUNT, to: "0xsomeone", amount: "100", txHash: "0xtx2" });
    const { swaps, remaining } = pairSwapLegs([out], ACCOUNT);
    expect(swaps).toHaveLength(0);
    expect(remaining).toEqual([out]);
  });

  test("two legs of the SAME token in one tx are not paired as a swap", () => {
    const a = leg({ tokenAddress: TOKEN, from: ACCOUNT, to: "0xrouter", amount: "100", txHash: "0xtx3" });
    const b = leg({ tokenAddress: TOKEN, from: "0xrouter", to: ACCOUNT, amount: "90", txHash: "0xtx3" });
    const { swaps, remaining } = pairSwapLegs([a, b], ACCOUNT);
    expect(swaps).toHaveLength(0);
    expect(remaining).toEqual([a, b]);
  });
});
