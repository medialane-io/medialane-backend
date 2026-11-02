import { describe, expect, test } from "bun:test";
import { sessionPredatesVerification } from "./sessionFreshness.js";

const VERIFIED_AT = new Date("2026-11-02T12:00:00Z");
const BEFORE = Math.floor(VERIFIED_AT.getTime() / 1000) - 3600;
const AFTER = Math.floor(VERIFIED_AT.getTime() / 1000) + 60;

const verifiedAt = (date: Date | null) => ({ verifiedAt: async () => date });

describe("sessionPredatesVerification", () => {
  test("a session issued after verification is fresh", async () => {
    expect(await sessionPredatesVerification("acc", AFTER, verifiedAt(VERIFIED_AT))).toBe(false);
  });

  test("a session issued before verification predates it", async () => {
    expect(await sessionPredatesVerification("acc", BEFORE, verifiedAt(VERIFIED_AT))).toBe(true);
  });

  test("a session issued in the same second as verification is fresh", async () => {
    const verified = new Date(VERIFIED_AT.getTime() + 400);
    expect(await sessionPredatesVerification("acc", Math.floor(VERIFIED_AT.getTime() / 1000), verifiedAt(verified))).toBe(false);
  });

  test("a session up to a minute before the recorded verification is fresh (clocks may differ)", async () => {
    expect(await sessionPredatesVerification("acc", Math.floor(VERIFIED_AT.getTime() / 1000) - 59, verifiedAt(VERIFIED_AT))).toBe(false);
  });

  test("an account that was never pending is never stale", async () => {
    expect(await sessionPredatesVerification("acc", BEFORE, verifiedAt(null))).toBe(false);
  });
});
