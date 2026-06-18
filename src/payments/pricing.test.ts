import { describe, expect, test } from "bun:test";
import { costForRequest } from "./pricing.js";

describe("costForRequest", () => {
  test("GET data routes cost 1 credit", () => {
    expect(costForRequest("GET", "/v1/tokens/0xabc")).toBe(1);
    expect(costForRequest("GET", "/v1/collections")).toBe(1);
  });
  test("POST /v1/intents costs 5 (trade intent)", () => {
    expect(costForRequest("POST", "/v1/intents")).toBe(5);
  });
  test("tenant self-service /v1/portal is NOT metered", () => {
    expect(costForRequest("GET", "/v1/portal/me")).toBeNull();
  });
  test("unknown metered route falls back to 1", () => {
    expect(costForRequest("GET", "/v1/something-new")).toBe(1);
  });
});
