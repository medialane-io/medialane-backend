import { describe, expect, test } from "bun:test";
import { resolveActionKey, FALLBACK_COST } from "./pricing.js";

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
  test("each sponsorship intent route resolves to its own actionKey", () => {
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-offer")).toBe("intent:sponsorship-offer");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-offer-open")).toBe("intent:sponsorship-offer-open");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-bid")).toBe("intent:sponsorship-bid");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-bid-retract")).toBe("intent:sponsorship-bid-retract");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-bid-accept")).toBe("intent:sponsorship-bid-accept");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-proposal")).toBe("intent:sponsorship-proposal");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-proposal-withdraw")).toBe("intent:sponsorship-proposal-withdraw");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-proposal-accept")).toBe("intent:sponsorship-proposal-accept");
    expect(resolveActionKey("POST", "/v1/intents/sponsorship-proposal-reject")).toBe("intent:sponsorship-proposal-reject");
  });
  test("GET /v1/prices resolves to its own actionKey, not the generic read default", () => {
    expect(resolveActionKey("GET", "/v1/prices")).toBe("price:read");
  });
  test("metadata upload routes resolve to their own actionKeys, not the generic default", () => {
    expect(resolveActionKey("POST", "/v1/metadata/upload")).toBe("metadata:upload-json");
    expect(resolveActionKey("POST", "/v1/metadata/upload-file")).toBe("metadata:upload-file");
    expect(resolveActionKey("POST", "/v1/metadata/upload-directory")).toBe("metadata:upload-directory");
  });
  test("the Pinata signed-url grant is priced like a real upload, not a generic read", () => {
    expect(resolveActionKey("GET", "/v1/metadata/signed-url")).toBe("metadata:signed-url");
  });
  test("other metadata routes stay the default read price", () => {
    expect(resolveActionKey("GET", "/v1/metadata/resolve")).toBe("read");
  });
  test("paymaster routes resolve to their own actionKeys, not the generic default", () => {
    expect(resolveActionKey("POST", "/v1/paymaster/invoke/build")).toBe("paymaster:invoke-build");
    expect(resolveActionKey("POST", "/v1/paymaster/invoke/execute")).toBe("paymaster:invoke-execute");
    expect(resolveActionKey("POST", "/v1/paymaster/deploy/build")).toBe("paymaster:deploy-build");
    expect(resolveActionKey("POST", "/v1/paymaster/deploy/execute")).toBe("paymaster:deploy-execute");
  });
  test("swap routes resolve to their own actionKeys, not the generic default", () => {
    expect(resolveActionKey("POST", "/v1/swap/quote/meter")).toBe("swap:quote");
    expect(resolveActionKey("POST", "/v1/swap/build/meter")).toBe("swap:build");
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
  test("wallet-activity has no special exemption — it's a metered read like any other GET", () => {
    expect(resolveActionKey("GET", "/v1/wallet-activity")).toBe("read");
  });
});

test("sending a verification code is metered, despite living under /v1/auth", () => {
  expect(resolveActionKey("POST", "/v1/auth/email/request-code")).toBe("auth:email-send");
});

test("the rest of /v1/auth stays free so sign-in survives a zero balance", () => {
  expect(resolveActionKey("POST", "/v1/auth/siws/nonce")).toBeNull();
  expect(resolveActionKey("POST", "/v1/auth/siws/verify")).toBeNull();
  expect(resolveActionKey("POST", "/v1/auth/email/verify-code")).toBeNull();
  expect(resolveActionKey("GET", "/v1/auth/email/exists")).toBeNull();
});

test("the portal stays unmetered", () => {
  expect(resolveActionKey("GET", "/v1/portal/anything")).toBeNull();
});

test("a GET to the code path is not accidentally priced as a send", () => {
  expect(resolveActionKey("GET", "/v1/auth/email/request-code")).toBeNull();
});

test("provisioning a recipient is charged as a wallet deployment", () => {
  expect(resolveActionKey("POST", "/v1/business/provisioning")).toBe("wallet:deploy");
});

test("recording a handoff is not charged as a deployment", () => {
  expect(resolveActionKey("POST", "/v1/business/provisioning/handoff")).toBe("read");
});

test("completing a handoff is not charged as a deployment", () => {
  expect(resolveActionKey("POST", "/v1/business/provisioning/prov_1/complete")).toBe("read");
});

test("reading the handoff calls is not charged as a deployment", () => {
  expect(resolveActionKey("GET", "/v1/business/provisioning/prov_1/handoff-calls")).toBe("read");
});

test("prefix rules elsewhere still match their sub-paths", () => {
  expect(resolveActionKey("POST", "/v1/intents/mint")).toBe("intent:mint");
  expect(resolveActionKey("POST", "/v1/intents/mint/anything")).toBe("intent:mint");
});

test("reading provisioning is not charged as a deployment", () => {
  expect(resolveActionKey("GET", "/v1/business/provisioning")).toBe("read");
});

test("a wallet deployment falls back to ten credits when unpriced", () => {
  expect(FALLBACK_COST["wallet:deploy"]).toBe(10);
});
