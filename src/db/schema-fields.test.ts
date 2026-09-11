import { test, expect } from "bun:test";
import { fieldsOf, unknownFields, assertWritable } from "./schema-fields.js";

test("a model's fields come from the schema itself", () => {
  const fields = fieldsOf("Payment");
  expect(fields.has("apiClientId")).toBe(true);
  expect(fields.has("proofNonce")).toBe(true);
});

test("the field that broke crediting is absent, as the schema says", () => {
  expect(fieldsOf("Payment").has("accountId")).toBe(false);
});

test("a write of real fields reports nothing", () => {
  expect(unknownFields("Payment", { apiClientId: "c1", txHash: "0x1" })).toEqual([]);
});

test("a write of an absent field is reported", () => {
  expect(unknownFields("Payment", { accountId: "a1" })).toEqual(["accountId"]);
});

test("asserting a good write passes", () => {
  expect(() => assertWritable("Payment", { apiClientId: "c1" })).not.toThrow();
});

test("asserting a bad write names the field", () => {
  expect(() => assertWritable("Payment", { accountId: "a1" })).toThrow('Payment has no field "accountId"');
});

test("an unknown model is an error rather than a silent pass", () => {
  expect(() => fieldsOf("Nonexistent")).toThrow('No model named "Nonexistent"');
});
