import { test, expect } from "bun:test";
import { normalizeAddress } from "../utils/starknet.js";

// Pure re-implementation guard: the allowlist check is address-normalized, so
// zero-padding differences between wallets and the env value still match.
test("normalized allowlist matches regardless of zero-padding", () => {
  const padded = normalizeAddress("STARKNET", "0x01");
  const allow = [normalizeAddress("STARKNET", "0x1")];
  expect(allow.includes(padded)).toBe(true);
});
