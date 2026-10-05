import { describe, expect, test } from "bun:test";
import { env } from "../config/env";
import { verifyConfirmToken } from "../utils/emailConfirmToken";
import { productionSweepDeps, toWelcomeCandidate, welcomeAccountWhere, welcomeSweepWhere } from "./prismaDeps";

const IO = "client_IO";
const created = new Date("2026-10-03T12:00:00Z");

const identity = (over: Partial<Parameters<typeof toWelcomeCandidate>[0]["identities"][number]>) => ({
  scheme: "email",
  value: null,
  clientId: IO,
  verifiedAt: null,
  address: null,
  createdAt: created,
  ...over,
});

const account = (identities: ReturnType<typeof identity>[]) => ({ id: "acc_1", status: "PENDING" as const, createdAt: created, identities });

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

describe("reading an account into a welcome candidate", () => {
  test("takes the io email from its value and the wallet address", () => {
    const a = toWelcomeCandidate(
      account([identity({ value: "a@b.co" }), identity({ scheme: "wallet", address: "0xabc", clientId: IO })]),
      IO,
    );
    expect(a).toMatchObject({ accountId: "acc_1", email: "a@b.co", walletAddress: "0xabc" });
  });

  test("an account whose email is verified is marked so, and one that is not is marked unverified", () => {
    const wallet = identity({ scheme: "wallet", address: "0xabc" });
    expect(toWelcomeCandidate(account([identity({ value: "a@b.co", verifiedAt: created }), wallet]), IO)?.facts.emailVerified).toBe(true);
    expect(toWelcomeCandidate(account([identity({ value: "a@b.co" }), wallet]), IO)?.facts.emailVerified).toBe(false);
  });

  test("shows the oldest wallet", () => {
    const email = identity({ value: "a@b.co" });
    const older = identity({ scheme: "wallet", address: "0xold", createdAt: new Date("2026-10-01T00:00:00Z") });
    const newer = identity({ scheme: "wallet", address: "0xnew", createdAt: new Date("2026-10-02T00:00:00Z") });
    expect(toWelcomeCandidate(account([email, newer, older]), IO)?.walletAddress).toBe("0xold");
  });

  test("an account with no io email or no wallet is not a candidate", () => {
    const wallet = identity({ scheme: "wallet", address: "0xabc" });
    expect(toWelcomeCandidate(account([wallet]), IO)).toBeNull();
    expect(toWelcomeCandidate(account([identity({ value: "a@b.co", clientId: "client_OTHER" }), wallet]), IO)).toBeNull();
    expect(toWelcomeCandidate(account([identity({ value: "a@b.co" })]), IO)).toBeNull();
  });
});

describe("which accounts the welcome queries look at", () => {
  const now = new Date("2026-10-03T12:00:00Z");

  test("looking at one account to re-check it ignores whether it was welcomed, because the notice has just been claimed for it", () => {
    expect(welcomeAccountWhere("acc_1")).toEqual({ id: "acc_1" });
    expect(JSON.stringify(welcomeAccountWhere("acc_1"))).not.toContain("notices");
  });

  test("the sweep only picks accounts that have not been welcomed, are open, and are less than a week old", () => {
    const where = welcomeSweepWhere(now, IO) as { status: unknown; createdAt: { gt: Date }; notices: unknown };
    expect(where.notices).toEqual({ none: { kind: "welcome" } });
    expect(where.status).toEqual({ not: "INACTIVE" });
    expect(where.createdAt.gt.toISOString()).toBe("2026-09-26T12:00:00.000Z");
  });

  test("the sweep only picks accounts with an io email and a wallet", () => {
    const text = JSON.stringify(welcomeSweepWhere(now, IO));
    expect(text).toContain(IO);
    expect(text).toContain('"scheme":"wallet"');
  });
});
