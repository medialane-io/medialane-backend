import { describe, expect, test } from "bun:test";
import { appNameForClient, clientIdForApp, type AppLookupDb } from "./resolve.js";

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

describe("clientIdForApp", () => {
  const db = (rows: Record<string, string | null>) => ({
    app: { findUnique: async ({ where }: { where: { name: string } }) => (where.name in rows ? { clientId: rows[where.name]! } : null) },
  });

  test("returns the client an app is bound to", async () => {
    expect(await clientIdForApp("MEDIALANE_IO", db({ MEDIALANE_IO: "c-io" }))).toBe("c-io");
  });

  test("returns null for an app that is not bound or not registered", async () => {
    expect(await clientIdForApp("MEDIALANE_IO", db({ MEDIALANE_IO: null as never }))).toBeNull();
    expect(await clientIdForApp("UNKNOWN", db({}))).toBeNull();
  });
});
