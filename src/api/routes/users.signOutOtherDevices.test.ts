import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const updates: Array<{ where: { id: string }; data: { sessionsValidFrom: Date } }> = [];
mock.module("../../db/client.js", () => ({
  default: {
    account: {
      findUnique: async () => ({ status: "ACTIVE", sessionsValidFrom: null }),
      update: async (args: (typeof updates)[number]) => {
        updates.push(args);
        return { id: args.where.id };
      },
    },
  },
}));

const { issueAccountSessionToken, readAccountSession } = await import("../../utils/accountSessionToken.js");
const users = (await import("./users.js")).default;

const app = new Hono<AppEnv>();
app.route("/users", users);
const signOutOthers = (headers: Record<string, string> = {}) =>
  app.request("/users/me/sign-out-other-devices", { method: "POST", headers });

beforeEach(() => {
  updates.length = 0;
});

test("signing out other devices sets the cutoff and returns a session that is still valid", async () => {
  const res = await signOutOthers({ "x-account-session": issueAccountSessionToken("acc_1") });
  expect(res.status).toBe(200);
  expect(updates).toHaveLength(1);
  expect(updates[0]!.where).toEqual({ id: "acc_1" });
  const cutoff = updates[0]!.data.sessionsValidFrom;
  expect(cutoff.getTime() % 1000).toBe(0);
  expect(Math.abs(Date.now() - cutoff.getTime())).toBeLessThan(2000);
  const { accountToken } = (await res.json()) as { accountToken: string };
  const fresh = readAccountSession(accountToken);
  expect(fresh?.accountId).toBe("acc_1");
  expect(fresh!.issuedAt * 1000).toBeGreaterThanOrEqual(cutoff.getTime());
});

test("without a session it answers 401 and changes nothing", async () => {
  const res = await signOutOthers();
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "Invalid or expired session" });
  expect(updates).toHaveLength(0);
});

