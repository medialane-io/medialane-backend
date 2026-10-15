import { expect, test } from "bun:test";
import { apiKeyGate } from "./apiKeyGate.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { appId } from "./appId.js";

test("the gate checks the key, names the app and meters; it asks for no account session", () => {
  expect(apiKeyGate).toHaveLength(3);
  expect(apiKeyGate[0]).toBe(apiKeyAuth);
  expect(apiKeyGate[1]).toBe(appId);
});
