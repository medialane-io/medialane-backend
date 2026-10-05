import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

async function appWith(opts: { ownedKeyId?: string } = {}) {
  const order: string[] = [];
  const deleteMany = mock(async (_arg?: unknown) => {
    order.push("deleteMany");
    return { count: 1 };
  });
  const create = mock(async ({ data }: { data: { prefix: string; label?: string } }) => {
    order.push("create");
    return { id: "k-new", prefix: data.prefix, label: data.label ?? null };
  });
  const del = mock(async (_arg?: unknown) => ({}));
  const findFirst = mock(async ({ where }: { where: { id: string } }) =>
    where.id === opts.ownedKeyId ? { id: where.id, status: "ACTIVE" } : null,
  );
  mock.module("../../db/client.js", () => ({
    default: {
      account: {
        findUnique: mock(async () => ({
          id: "a1",
          status: "ACTIVE",
          sessionsValidFrom: null,
          apiClient: { id: "ac1", accountId: "a1", plan: "PREMIUM", creditBalance: 0 },
        })),
      },
      apiKey: { findFirst, delete: del, findMany: mock(async () => []) },
      $transaction: mock(async (run: (tx: unknown) => Promise<unknown>) => run({ apiKey: { deleteMany, create } })),
    },
  }));
  const { default: portal } = await import("./portal.js");
  const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");
  const app = new Hono<AppEnv>();
  app.route("/", portal);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueAccountSessionToken("a1")}` };
  return { app, headers, deleteMany, create, del, order };
}

describe("an account has one API key", () => {
  test("creating a key replaces the account's existing key in one transaction", async () => {
    const { app, headers, deleteMany, create, order } = await appWith();
    const res = await app.request("/keys", { method: "POST", headers, body: JSON.stringify({}) });
    expect(res.status).toBe(201);
    expect(order).toEqual(["deleteMany", "create"]);
    expect(deleteMany).toHaveBeenCalledWith({ where: { apiClientId: "ac1" } });
    expect(create).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { data: { id: string; prefix: string; plaintext: string } };
    expect(body.data.id).toBe("k-new");
    expect(body.data.plaintext.startsWith("ml_live_")).toBe(true);
  });

  test("deleting the account's key removes it", async () => {
    const { app, headers, del } = await appWith({ ownedKeyId: "k1" });
    const res = await app.request("/keys/k1", { method: "DELETE", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "k1", status: "REVOKED" } });
    expect(del).toHaveBeenCalledWith({ where: { id: "k1" } });
  });

  test("deleting a key that is not the account's is a 404 and removes nothing", async () => {
    const { app, headers, del } = await appWith({ ownedKeyId: "k1" });
    const res = await app.request("/keys/someone-elses", { method: "DELETE", headers });
    expect(res.status).toBe(404);
    expect(del).not.toHaveBeenCalled();
  });
});
