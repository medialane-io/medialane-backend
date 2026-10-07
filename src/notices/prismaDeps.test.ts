import { describe, expect, test } from "bun:test";
import { env } from "../config/env";
import { verifyConfirmToken } from "../utils/emailConfirmToken";
import { productionSweepDeps } from "./prismaDeps";

describe("the confirm token in the notice emails", () => {
  test("opens for exactly that account and email, until the account's deadline", () => {
    const deadline = new Date("2026-10-10T12:00:00Z");
    const token = productionSweepDeps().confirmToken("acc_1", "a@b.co", deadline);
    const claims = verifyConfirmToken(env.SIWS_SECRET, token, new Date("2026-10-04T00:00:00Z"));
    expect(claims?.accountId).toBe("acc_1");
    expect(claims?.email).toBe("a@b.co");
    expect(claims?.expiresAt.getTime()).toBe(deadline.getTime());
  });
});
