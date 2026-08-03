import { describe, expect, test } from "bun:test";
import { resolveActionKey } from "./pricing.js";

// costForRequest itself hits the DB (PricingRule cache + Collection lookups
// for mint/create-collection) — covered by integration/e2e, not unit tests.
// resolveActionKey is the pure, DB-free routing logic and is what's worth
// unit-testing here.
describe("resolveActionKey", () => {
  test("GET data routes resolve to the default read action", () => {
    expect(resolveActionKey("GET", "/v1/tokens/0xabc")).toBe("read");
    expect(resolveActionKey("GET", "/v1/collections")).toBe("read");
  });
  test("each intent route resolves to its own actionKey", () => {
    expect(resolveActionKey("POST", "/v1/intents/mint")).toBe("intent:mint");
    expect(resolveActionKey("POST", "/v1/intents/create-collection")).toBe("intent:create-collection");
    expect(resolveActionKey("POST", "/v1/intents/create-tier")).toBe("intent:create-tier");
    expect(resolveActionKey("POST", "/v1/intents/listing")).toBe("intent:listing");
    expect(resolveActionKey("POST", "/v1/intents/offer")).toBe("intent:offer");
    expect(resolveActionKey("POST", "/v1/intents/cancel")).toBe("intent:cancel");
    expect(resolveActionKey("POST", "/v1/intents/fulfill")).toBe("intent:fulfill");
    expect(resolveActionKey("POST", "/v1/intents/counter-offer")).toBe("intent:counter-offer");
    expect(resolveActionKey("POST", "/v1/intents/checkout")).toBe("intent:checkout");
  });
  test("GET /v1/prices resolves to its own actionKey, not the generic read default", () => {
    expect(resolveActionKey("GET", "/v1/prices")).toBe("price:read");
  });
  test("metadata upload routes resolve to their own actionKeys, not the generic default", () => {
    expect(resolveActionKey("POST", "/v1/metadata/upload")).toBe("metadata:upload-json");
    expect(resolveActionKey("POST", "/v1/metadata/upload-file")).toBe("metadata:upload-file");
  });
  test("other metadata routes stay the default read price", () => {
    expect(resolveActionKey("GET", "/v1/metadata/resolve")).toBe("read");
    expect(resolveActionKey("GET", "/v1/metadata/signed-url")).toBe("read");
  });
  test("tenant self-service /v1/portal is NOT metered", () => {
    expect(resolveActionKey("GET", "/v1/portal/me")).toBeNull();
  });
  test("/v1/auth is NOT metered", () => {
    expect(resolveActionKey("POST", "/v1/auth/siws/verify")).toBeNull();
  });
  test("unknown metered route falls back to read", () => {
    expect(resolveActionKey("GET", "/v1/something-new")).toBe("read");
  });
});
