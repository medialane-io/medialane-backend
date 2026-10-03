import { describe, expect, test } from "bun:test";
import { env } from "../config/env";
import { verifyConfirmToken } from "../utils/emailConfirmToken";
import { productionSweepDeps, toWelcomeCandidate } from "./prismaDeps";

const IO = "client_IO";
const created = new Date("2026-10-03T12:00:00Z");

const identity = (over: Partial<Parameters<typeof toWelcomeCandidate>[0]["identities"][number]>) => ({
  scheme: "email",
  email: null,
  value: null,
  clientId: IO,
  verifiedAt: null,
  address: null,
  isPrimary: false,
  createdAt: created,
  ...over,
});

const account = (identities: ReturnType<typeof identity>[]) => ({ id: "acc_1", status: "PENDING" as const, createdAt: created, identities });

describe("the confirm link in the notice emails", () => {
  test("opens for exactly that account and email, until the account's deadline", () => {
    const deadline = new Date("2026-10-10T12:00:00Z");
    const url = productionSweepDeps().confirmUrl("acc_1", "a@b.co", deadline);
    expect(url.startsWith(`${env.IO_APP_URL}/confirm-email?token=`)).toBe(true);
    const token = decodeURIComponent(url.split("token=")[1]!);
    const claims = verifyConfirmToken(env.SIWS_SECRET, token, new Date("2026-10-04T00:00:00Z"));
    expect(claims?.accountId).toBe("acc_1");
    expect(claims?.email).toBe("a@b.co");
    expect(claims?.expiresAt.getTime()).toBe(deadline.getTime());
  });

  test("the security link goes to the recovery settings page", () => {
    expect(productionSweepDeps().settingsUrl).toBe(`${env.IO_APP_URL}/settings/recovery`);
  });
});

describe("reading an account into a welcome candidate", () => {
  test("takes the io email, whether it is stored as the email or the value, and the wallet address", () => {
    const a = toWelcomeCandidate(
      account([identity({ email: "a@b.co" }), identity({ scheme: "wallet", address: "0xabc", clientId: IO })]),
      IO,
    );
    expect(a).toMatchObject({ accountId: "acc_1", email: "a@b.co", walletAddress: "0xabc" });
    const b = toWelcomeCandidate(account([identity({ value: "c@d.co" }), identity({ scheme: "wallet", address: "0xabc" })]), IO);
    expect(b?.email).toBe("c@d.co");
  });

  test("an account whose email is verified is marked so, and one that is not is marked unverified", () => {
    const wallet = identity({ scheme: "wallet", address: "0xabc" });
    expect(toWelcomeCandidate(account([identity({ email: "a@b.co", verifiedAt: created }), wallet]), IO)?.facts.emailVerified).toBe(true);
    expect(toWelcomeCandidate(account([identity({ email: "a@b.co" }), wallet]), IO)?.facts.emailVerified).toBe(false);
  });

  test("shows the primary wallet, or else the oldest", () => {
    const email = identity({ email: "a@b.co" });
    const older = identity({ scheme: "wallet", address: "0xold", createdAt: new Date("2026-10-01T00:00:00Z") });
    const newer = identity({ scheme: "wallet", address: "0xnew", createdAt: new Date("2026-10-02T00:00:00Z") });
    const primary = identity({ scheme: "wallet", address: "0xprimary", isPrimary: true, createdAt: new Date("2026-10-03T00:00:00Z") });
    expect(toWelcomeCandidate(account([email, newer, older]), IO)?.walletAddress).toBe("0xold");
    expect(toWelcomeCandidate(account([email, newer, older, primary]), IO)?.walletAddress).toBe("0xprimary");
  });

  test("an account with no io email or no wallet is not a candidate", () => {
    const wallet = identity({ scheme: "wallet", address: "0xabc" });
    expect(toWelcomeCandidate(account([wallet]), IO)).toBeNull();
    expect(toWelcomeCandidate(account([identity({ email: "a@b.co", clientId: "client_OTHER" }), wallet]), IO)).toBeNull();
    expect(toWelcomeCandidate(account([identity({ email: "a@b.co" })]), IO)).toBeNull();
  });
});
