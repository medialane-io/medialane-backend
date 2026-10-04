import { describe, expect, test } from "bun:test";
import { claimFirstPartyClients, type ClaimDb } from "./claim.js";

function fakeDb(opts: {
  apps: { name: string; displayName: string; clientId: string | null }[];
  clientsByProfileName: Record<string, string[]>;
}) {
  const updates: { name: string; clientId: string }[] = [];
  const db: ClaimDb = {
    app: {
      findMany: async () => opts.apps.filter((a) => a.clientId === null).map(({ name, displayName }) => ({ name, displayName })),
      update: async ({ where, data }) => {
        updates.push({ name: where.name, clientId: data.clientId });
        return {};
      },
    },
    apiClient: {
      findMany: async ({ where }) =>
        (opts.clientsByProfileName[where.account.profile.name] ?? []).map((id) => ({ id })),
    },
  };
  return { db, updates };
}

describe("claimFirstPartyClients", () => {
  test("binds an app with no client to the one client whose account has its display name", async () => {
    const { db, updates } = fakeDb({
      apps: [{ name: "MEDIALANE_IO", displayName: "Medialane.io", clientId: null }],
      clientsByProfileName: { "Medialane.io": ["c-io"] },
    });
    const result = await claimFirstPartyClients(db);
    expect(updates).toEqual([{ name: "MEDIALANE_IO", clientId: "c-io" }]);
    expect(result).toEqual({ linked: ["MEDIALANE_IO"], unlinked: [] });
  });

  test("never guesses: several matching clients leave the app unlinked", async () => {
    const { db, updates } = fakeDb({
      apps: [{ name: "MEDIALANE_IO", displayName: "Medialane.io", clientId: null }],
      clientsByProfileName: { "Medialane.io": ["c1", "c2"] },
    });
    expect(await claimFirstPartyClients(db)).toEqual({ linked: [], unlinked: ["MEDIALANE_IO"] });
    expect(updates).toEqual([]);
  });

  test("no matching client leaves the app unlinked", async () => {
    const { db } = fakeDb({
      apps: [{ name: "MEDIALANE_DAO", displayName: "Medialane DAO", clientId: null }],
      clientsByProfileName: {},
    });
    expect(await claimFirstPartyClients(db)).toEqual({ linked: [], unlinked: ["MEDIALANE_DAO"] });
  });

  test("an app that already has a client is left alone", async () => {
    const { db, updates } = fakeDb({
      apps: [{ name: "MEDIALANE_IO", displayName: "Medialane.io", clientId: "already" }],
      clientsByProfileName: { "Medialane.io": ["someone-else"] },
    });
    expect(await claimFirstPartyClients(db)).toEqual({ linked: [], unlinked: [] });
    expect(updates).toEqual([]);
  });
});
