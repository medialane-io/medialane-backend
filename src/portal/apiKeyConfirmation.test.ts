import { describe, expect, test } from "bun:test";
import { apiKeyConfirmationTypedData } from "@medialane/sdk/starknet";
import { CONFIRMATION_MAX_SECONDS, confirmKeyChange, type KeyConfirmationDeps } from "./apiKeyConfirmation.js";

const NOW = 1_700_000_000;
const WALLET = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

function deps(over: Partial<KeyConfirmationDeps> = {}) {
  const verified: Array<{ address: string; typedData: unknown; signature: string[] }> = [];
  const d: KeyConfirmationDeps = {
    account: async () => ({ publicId: "acc_ABC", wallet: WALLET }),
    verify: async (input) => { verified.push(input); return true; },
    now: () => NOW,
    ...over,
  };
  return { d, verified };
}

const change = { action: "replace_api_key", key: "none" } as const;
const ok = { expiresAt: NOW + 120, signature: ["0x1", "0x2"] };

describe("confirming an API key change", () => {
  test("the account's wallet signature over exactly this change is accepted", async () => {
    const { d, verified } = deps();
    expect(await confirmKeyChange(d, "a1", change, ok)).toBe(true);
    expect(verified).toEqual([{
      address: WALLET,
      typedData: apiKeyConfirmationTypedData({ action: "replace_api_key", key: "none", account: "acc_ABC", expiresAt: NOW + 120 }),
      signature: ["0x1", "0x2"],
    }]);
  });

  test("a signature the wallet did not make is refused", async () => {
    const { d } = deps({ verify: async () => false });
    expect(await confirmKeyChange(d, "a1", change, ok)).toBe(false);
  });

  test("an expired confirmation is refused without checking the signature", async () => {
    const { d, verified } = deps();
    expect(await confirmKeyChange(d, "a1", change, { ...ok, expiresAt: NOW - 1 })).toBe(false);
    expect(verified).toEqual([]);
  });

  test("a confirmation valid for longer than the limit is refused", async () => {
    const { d } = deps();
    expect(await confirmKeyChange(d, "a1", change, { ...ok, expiresAt: NOW + CONFIRMATION_MAX_SECONDS + 1 })).toBe(false);
  });

  test("a missing or malformed confirmation is refused", async () => {
    const { d } = deps();
    for (const bad of [undefined, null, {}, { expiresAt: "soon", signature: ["0x1"] }, { expiresAt: NOW + 60, signature: [] }]) {
      expect(await confirmKeyChange(d, "a1", change, bad)).toBe(false);
    }
  });

  test("an account without a wallet cannot confirm", async () => {
    const { d } = deps({ account: async () => ({ publicId: "acc_ABC", wallet: null }) });
    expect(await confirmKeyChange(d, "a1", change, ok)).toBe(false);
  });

  test("a signature check that fails to run refuses the change", async () => {
    const { d } = deps({ verify: async () => { throw new Error("rpc down"); } });
    expect(await confirmKeyChange(d, "a1", change, ok)).toBe(false);
  });
});
