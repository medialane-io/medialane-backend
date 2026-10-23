import { describe, expect, mock, test } from "bun:test";

type Row = { id: string; accountId: string | null; status: string; type: string; expiresAt: Date; txHash: string | null };

const future = new Date(Date.now() + 60_000);
const rows: Row[] = [
  { id: "mine", accountId: "acc_1", status: "PENDING", type: "CREATE_LISTING", expiresAt: future, txHash: null },
  { id: "theirs", accountId: "acc_2", status: "PENDING", type: "CREATE_LISTING", expiresAt: future, txHash: null },
  { id: "orphan", accountId: null, status: "PENDING", type: "CREATE_LISTING", expiresAt: future, txHash: null },
];

mock.module("../../../db/client.js", () => ({
  default: {
    transactionIntent: {
      findFirst: mock(async ({ where }: { where: { id: string; accountId: string } }) =>
        rows.find((r) => r.id === where.id && r.accountId === where.accountId) ?? null,
      ),
      updateMany: mock(async () => ({ count: 0 })),
    },
  },
}));

const { Hono } = await import("hono");
const { registerLifecycleRoutes } = await import("./lifecycle.js");
const { renderError } = await import("../../http/errors.js");

function app() {
  const a = new Hono<import("../../../types/hono.js").AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "acc_1", status: "ACTIVE" } as never);
    await next();
  });
  registerLifecycleRoutes(a);
  a.onError(renderError);
  return a;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const requests: Array<[string, (id: string) => [string, RequestInit]]> = [
  ["GET /:id", (id) => [`/${id}`, { method: "GET" }]],
  ["PATCH /:id/signature", (id) => [`/${id}/signature`, json("PATCH", { signature: ["0x1"] })]],
  ["POST /:id/hydrate", (id) => [`/${id}/hydrate`, { method: "POST" }]],
  ["PATCH /:id/confirm", (id) => [`/${id}/confirm`, json("PATCH", { txHash: "0x1" })]],
];

describe("an intent is only visible to the account it was built for", () => {
  test.each(requests)("%s: another account's intent, one with no owner and an unknown id all look the same", async (_name, request) => {
    for (const id of ["theirs", "orphan", "unknown"]) {
      const [path, init] = request(id);
      const res = await app().request(path, init);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Intent not found" });
    }
  });

  test("the owner can read it", async () => {
    const res = await app().request("/mine");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe("mine");
  });
});
