import { describe, expect, mock, test } from "bun:test";

const future = new Date(Date.now() + 60_000);
const row = {
  id: "mine",
  accountId: "acc_1",
  status: "PENDING",
  type: "CREATE_LISTING",
  chain: "STARKNET",
  requester: "0x1",
  typedData: { message: {} },
  calls: [],
  signature: null,
  expiresAt: future,
  txHash: null,
};
const updates: unknown[] = [];

mock.module("../../../db/client.js", () => ({
  default: {
    transactionIntent: {
      findFirst: mock(async ({ where }: { where: { id: string; accountId: string } }) =>
        where.id === row.id && where.accountId === row.accountId ? { ...row } : null,
      ),
      update: mock(async (args: unknown) => { updates.push(args); return row; }),
      updateMany: mock(async () => ({ count: 0 })),
    },
  },
}));

const { Hono } = await import("hono");
const { registerLifecycleRoutes } = await import("./lifecycle.js");
const { GuardianUnavailableError } = await import("../../../utils/guardianCosign.js");
const { renderError } = await import("../../http/errors.js");

function app() {
  const a = new Hono<import("../../../types/hono.js").AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "acc_1", status: "ACTIVE" } as never);
    await next();
  });
  registerLifecycleRoutes(a, async () => { throw new GuardianUnavailableError(); });
  a.onError(renderError);
  return a;
}

describe("signing an intent while the wallet's guardian cannot be read", () => {
  test("is refused for now and leaves the intent unsigned", async () => {
    const res = await app().request("/mine/signature", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: ["0x1", "0x2"] }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "The network can't be reached right now. Please try again in a moment." });
    expect(updates).toEqual([]);
  });
});
