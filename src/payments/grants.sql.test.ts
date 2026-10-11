import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.SQL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("granting credits", () => {
  let prisma: PrismaClient;
  let grants: typeof import("./grants.js");

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    grants = await import("./grants.js");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("a grant credits the account and records why and by whom", async () => {
    const publicId = `grant-${Date.now()}`;
    await prisma.account.create({ data: { publicId } });
    const result = await grants.grantToAccount(publicId, 500, "credits for the io app", "ops");
    expect(result.creditBalance).toBe(500);
    const entry = await prisma.creditEntry.findFirstOrThrow({ where: { apiCreditsId: result.apiCreditsId } });
    expect(entry).toMatchObject({ kind: "GRANT", credits: 500, note: "credits for the io app (by ops)" });
  });

  test("a grant needs a positive whole amount, a reason and an existing account", async () => {
    const publicId = `grant-bad-${Date.now()}`;
    await prisma.account.create({ data: { publicId } });
    await expect(grants.grantToAccount(publicId, 0, "x", "ops")).rejects.toThrow("positive");
    await expect(grants.grantToAccount(publicId, 1.5, "x", "ops")).rejects.toThrow("positive");
    await expect(grants.grantToAccount(publicId, 10, "  ", "ops")).rejects.toThrow("reason");
    await expect(grants.grantToAccount("nobody", 10, "x", "ops")).rejects.toThrow("no account");
  });
});
