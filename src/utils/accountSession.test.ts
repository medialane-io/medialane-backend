import { expect, mock, test } from "bun:test";

let row: { status: string; sessionsValidFrom: Date | null } | null = null;
mock.module("../db/client.js", () => ({
  default: { account: { findUnique: async () => row } },
}));

const { issueAccountSessionToken } = await import("./accountSessionToken.js");
const { currentSession, readSession } = await import("./accountSession.js");

const HOUR = 3600 * 1000;

test("a session issued before the account's cutoff is invalid", async () => {
  row = { status: "ACTIVE", sessionsValidFrom: new Date(Date.now() + HOUR) };
  const token = issueAccountSessionToken("acc_1");
  expect(await readSession(token)).toEqual({ verdict: "invalid" });
  expect(await currentSession(token)).toBeNull();
});

test("a session issued after the account's cutoff is accepted", async () => {
  row = { status: "ACTIVE", sessionsValidFrom: new Date(Date.now() - HOUR) };
  const token = issueAccountSessionToken("acc_1");
  expect(await readSession(token)).toMatchObject({ verdict: "ok", accountId: "acc_1" });
  expect((await currentSession(token))?.accountId).toBe("acc_1");
});

test("an inactive account is reported as inactive", async () => {
  row = { status: "INACTIVE", sessionsValidFrom: new Date(Date.now() + HOUR) };
  expect(await readSession(issueAccountSessionToken("acc_1"))).toEqual({ verdict: "inactive" });
});

test("a session for an account that does not exist is invalid", async () => {
  row = null;
  expect(await readSession(issueAccountSessionToken("acc_1"))).toEqual({ verdict: "invalid" });
});
