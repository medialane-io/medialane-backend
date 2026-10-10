import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("GET /users/me with an account session", () => {
  let prisma: PrismaClient;
  let app: Hono<AppEnv>;
  let issue: (accountId: string) => string;
  const appId = "MEDIALANE_IO";

  beforeAll(async () => {
    prisma = (await import("../../db/client.js")).default;
    const users = (await import("./users.js")).default;
    issue = (await import("../../utils/accountSessionToken.js")).issueAccountSessionToken;
    await prisma.app.upsert({ where: { id: appId }, create: { id: appId, name: "Medialane" }, update: {} });
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("appId", appId);
      await next();
    });
    app.route("/users", users);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const account = (status: "ACTIVE" | "PENDING" | "INACTIVE", email: string, wallet?: string) =>
    prisma.account.create({
      data: {
        publicId: `session-${email}`,
        status,
        identities: {
          create: [
            { scheme: "email", value: email, appId },
            ...(wallet ? [{ scheme: "wallet", chain: "STARKNET" as const, address: wallet, appId }] : []),
          ],
        },
      },
      select: { id: true },
    });

  const me = (token: string) => app.request("/users/me", { headers: { "x-account-session": token } });

  test("a new account without a wallet is signed in, with its email", async () => {
    const { id } = await account("PENDING", "new@example.com");
    const res = await me(issue(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { walletAddress: string | null; accountId: string; email: string };
    expect(body).toMatchObject({ walletAddress: null, accountId: id, email: "new@example.com" });
  });

  test("an account with a wallet returns it", async () => {
    const wallet = "0x0000000000000000000000000000000000000000000000000000000000000abc";
    const { id } = await account("ACTIVE", "has-wallet@example.com", wallet);
    const body = (await (await me(issue(id))).json()) as { walletAddress: string };
    expect(body.walletAddress).toBe(wallet);
  });

  test("an inactive account's session is refused", async () => {
    const { id } = await account("INACTIVE", "gone@example.com");
    const res = await me(issue(id));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Account is not active", code: "account_inactive" });
  });

  test("no session and no token is signed out", async () => {
    const res = await app.request("/users/me");
    expect(res.status).toBe(401);
  });
});
