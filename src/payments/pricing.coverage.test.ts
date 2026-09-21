import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { ROUTE_ACTIONS, resolveActionKey } from "./pricing.js";

const DEFAULT_ACTION_KEY = "read";

function mountedPrefixes(): string[] {
  const server = readFileSync("src/api/server.ts", "utf8");
  return [...server.matchAll(/app\.route\("(\/v1[^"]*)"/g)].map((m) => m[1]!);
}

const PRICED_AS_A_PLAIN_READ = new Set([
  "/v1/collections/claim", "/v1/wallet-activity", "/v1/username-claims",
  "/v1/collection-slug-claims", "/v1/users", "/v1/remix-offers",
  "/v1/auth/siws", "/v1/portal", "/v1/orders", "/v1/tokens", "/v1",
  "/v1/collections", "/v1/coins", "/v1/activities", "/v1/search",
  "/v1/stats", "/v1/events", "/v1/reports", "/v1/pop", "/v1/drop",
  "/v1/sponsorship", "/v1/rewards", "/v1/business/provisioning",
  "/v1/business/issuance", "/v1/auth/email", "/v1/intents", "/v1/metadata",
]);

describe("every mounted route has a pricing decision", () => {
  test("a route is either priced by an action or knowingly a plain read", () => {
    const undecided = mountedPrefixes().filter((prefix) => {
      if (PRICED_AS_A_PLAIN_READ.has(prefix)) return false;
      return !ROUTE_ACTIONS.some((rule) => rule.prefix === prefix || rule.prefix.startsWith(prefix + "/"));
    });

    expect(undecided).toEqual([]);
  });

  test("an unmatched path still resolves, so nothing goes unmetered", () => {
    expect(resolveActionKey("GET", "/v1/something-new")).toBe(DEFAULT_ACTION_KEY);
  });
});
