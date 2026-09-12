import { test, expect } from "bun:test";
import { hash, num } from "starknet";
import { signedCalls, disallowedEntrypoint } from "./paymaster.js";

const call = (to: string, entrypoint: string) => ({
  To: to,
  Selector: num.toHex(hash.getSelectorFromName(entrypoint)),
  Calldata: [],
});

const FEE_PLACEHOLDER = { To: "0x0", Selector: "0x0", Calldata: [] };

test("every call in the signed message is read back, not only the declared ones", () => {
  const typedData = { message: { Calls: [call("0x1", "approve"), call("0x2", "transfer")] } };
  expect(signedCalls(typedData).map((c) => c.entrypoint)).toEqual(["approve", "transfer"]);
});

test("a call the caller never declared is still checked against the allowlist", () => {
  const typedData = {
    message: { Calls: [call("0x1", "approve"), call("0xdead", "upgrade")] },
  };
  const signed = signedCalls(typedData);
  expect(signed).toHaveLength(2);
  expect(disallowedEntrypoint(signed)).toContain("unknown selector");
});

test("the inert fee placeholder is not treated as a call", () => {
  const typedData = { message: { Calls: [call("0x1", "approve"), FEE_PLACEHOLDER] } };
  expect(signedCalls(typedData)).toHaveLength(1);
});

test("lowercase keys are read the same as capitalised ones", () => {
  const typedData = {
    message: { calls: [{ to: "0x1", selector: num.toHex(hash.getSelectorFromName("mint")), calldata: [] }] },
  };
  expect(signedCalls(typedData).map((c) => c.entrypoint)).toEqual(["mint"]);
});

test("a message with no calls reads as none, rather than throwing", () => {
  expect(signedCalls({ message: {} })).toEqual([]);
  expect(signedCalls(null)).toEqual([]);
  expect(signedCalls({ message: { Calls: "not-an-array" } })).toEqual([]);
});

test("an unrecognised selector never resolves to an allowed entrypoint", () => {
  const typedData = { message: { Calls: [{ To: "0x1", Selector: "0xdeadbeef", Calldata: [] }] } };
  expect(disallowedEntrypoint(signedCalls(typedData))).toContain("unknown selector");
});
