import { describe, expect, mock, test } from "bun:test";
import { registerApp, type RegisterAppDb } from "./register.js";

function fakeDb(opts: { existingApps?: string[]; clients?: string[]; boundClients?: string[]; identitiesToSet?: number } = {}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const db: RegisterAppDb = {
    app: {
      findUnique: mock(async ({ where }: { where: { name?: string; clientId?: string } }) => {
        if (where.name) return opts.existingApps?.includes(where.name) ? { name: where.name } : null;
        return opts.boundClients?.includes(where.clientId!) ? { name: "OTHER_APP" } : null;
      }),
      create: mock(async (args: unknown) => {
        created.push(args);
        return {};
      }),
    },
    apiClient: { findUnique: mock(async ({ where }: { where: { id: string } }) => (opts.clients?.includes(where.id) ? { id: where.id } : null)) },
    identity: {
      updateMany: mock(async (args: unknown) => {
        updated.push(args);
        return { count: opts.identitiesToSet ?? 0 };
      }),
    },
  };
  return { db, created, updated };
}

const input = { name: "EXAMPLE_APP", displayName: "Example App", clientId: "c1" };

describe("registerApp", () => {
  test("registers the app, binds it to the client and sets app on that client's identities that have none", async () => {
    const { db, created, updated } = fakeDb({ clients: ["c1"], identitiesToSet: 3 });
    const result = await registerApp(db, input);
    expect(result).toEqual({ name: "EXAMPLE_APP", clientId: "c1", identitiesUpdated: 3 });
    expect(created).toEqual([{ data: { name: "EXAMPLE_APP", displayName: "Example App", clientId: "c1", emailConfirmDays: null } }]);
    expect(updated).toEqual([{ where: { clientId: "c1", app: null }, data: { app: "EXAMPLE_APP" } }]);
  });

  test("takes an optional email confirmation window", async () => {
    const { db, created } = fakeDb({ clients: ["c1"] });
    await registerApp(db, { ...input, emailConfirmDays: 5 });
    expect((created[0] as { data: { emailConfirmDays: number } }).data.emailConfirmDays).toBe(5);
  });

  test("refuses a name that is not an upper-case name", async () => {
    const { db, created } = fakeDb({ clients: ["c1"] });
    await expect(registerApp(db, { ...input, name: "bad name" })).rejects.toThrow(/name/i);
    expect(created).toEqual([]);
  });

  test("refuses an empty display name", async () => {
    const { db } = fakeDb({ clients: ["c1"] });
    await expect(registerApp(db, { ...input, displayName: "  " })).rejects.toThrow(/display name/i);
  });

  test("refuses a name that is already registered", async () => {
    const { db, created } = fakeDb({ clients: ["c1"], existingApps: ["EXAMPLE_APP"] });
    await expect(registerApp(db, input)).rejects.toThrow(/already registered/i);
    expect(created).toEqual([]);
  });

  test("refuses a client that does not exist", async () => {
    const { db, created } = fakeDb({ clients: [] });
    await expect(registerApp(db, input)).rejects.toThrow(/no client/i);
    expect(created).toEqual([]);
  });

  test("refuses a client that is already bound to an app", async () => {
    const { db, created, updated } = fakeDb({ clients: ["c1"], boundClients: ["c1"] });
    await expect(registerApp(db, input)).rejects.toThrow(/already bound/i);
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });
});
