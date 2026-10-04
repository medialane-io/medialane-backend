import { describe, expect, test } from "bun:test";
import { appNameForClient, type AppLookupDb } from "./resolve.js";

function fakeDb(links: Record<string, string>): AppLookupDb {
  return {
    app: {
      findUnique: async ({ where }) => (links[where.clientId] ? { name: links[where.clientId]! } : null),
    },
  };
}

describe("appNameForClient", () => {
  test("returns the app bound to the client", async () => {
    expect(await appNameForClient("c1", fakeDb({ c1: "MEDIALANE_IO" }))).toBe("MEDIALANE_IO");
  });

  test("returns null for a client no app is bound to", async () => {
    expect(await appNameForClient("unbound-client", fakeDb({ c1: "MEDIALANE_IO" }))).toBeNull();
  });
});
