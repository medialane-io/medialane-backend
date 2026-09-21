import { describe, expect, test } from "bun:test";
import { signatureIsRefused } from "./lifecycle.js";

describe("whose signature may be attached to an intent", () => {
  test("a signature proven to be the requester's is attached", () => {
    expect(signatureIsRefused({ ok: true })).toBe(false);
  });

  test("a signature proven not to be theirs is refused", () => {
    expect(signatureIsRefused({ ok: false, reason: "invalid" })).toBe(true);
  });

  test("a wallet not yet on chain cannot be checked, so it is not refused", () => {
    expect(signatureIsRefused({ ok: false, reason: "not_deployed" })).toBe(false);
  });
});
