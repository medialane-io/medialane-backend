import { test, expect } from "bun:test";
import { classifyPaymasterError } from "./paymaster.js";

function rpcError(executionError: string) {
  return {
    type: "RpcError",
    message: `RPC: paymaster_buildTransaction failed\n\n 156: An error occurred (TRANSACTION_EXECUTION_ERROR): {"execution_error":"${executionError}"}`,
    baseError: { code: 156, data: { execution_error: executionError } },
  };
}

test("an undeployed account is a client error, not an upstream failure", () => {
  const out = classifyPaymasterError(
    rpcError("Message(\\\"0x454e545259504f494e545f4e4f545f464f554e44 ('ENTRYPOINT_NOT_FOUND')\\\")"),
  );
  expect(out.status).toBe(422);
  expect(out.message).toContain("not deployed");
});

test("the classifier does not leak the raw RPC dump to the caller", () => {
  const out = classifyPaymasterError(rpcError("ENTRYPOINT_NOT_FOUND"));
  expect(out.message).not.toContain("paymaster_buildTransaction");
  expect(out.message).not.toContain("execution_error");
});

test("any other execution error is still the caller's transaction failing", () => {
  const out = classifyPaymasterError(rpcError("Message(\\\"insufficient balance\\\")"));
  expect(out.status).toBe(422);
  expect(out.message).toContain("could not be executed");
});

test("a missing paymaster key is a configuration fault, reported as unavailable", () => {
  const out = classifyPaymasterError(new Error("AVNU_PAYMASTER_API_KEY is not set"));
  expect(out.status).toBe(503);
  expect(out.message).toContain("not configured");
});

test("a network failure remains an upstream error", () => {
  expect(classifyPaymasterError(new Error("fetch failed")).status).toBe(502);
  expect(classifyPaymasterError(new Error("socket hang up")).status).toBe(502);
});

test("an unrecognised value does not throw and defaults to upstream", () => {
  expect(classifyPaymasterError(null).status).toBe(502);
  expect(classifyPaymasterError("weird").status).toBe(502);
  expect(classifyPaymasterError(undefined).status).toBe(502);
});
