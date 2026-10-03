import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.TEST_DATABASE_URL;
if (url && !/127\.0\.0\.1|localhost/.test(url)) throw new Error("The database tests only run against a local database.");

const enabled = Boolean(url);
const db = enabled ? (await import("../db/client.js")).default : null;
const deps = enabled ? await import("./prismaDeps.js") : null;
const sweep = enabled ? await import("./sweep.js") : null;
const expiry = enabled ? await import("../orchestrator/unverifiedAccounts.js") : null;

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const IO = process.env.IO_CLIENT_ID ?? "client_IO_TEST";
const OTHER = "client_OTHER_TEST";

let counter = 0;
const uid = () => `t${++counter}_${Math.random().toString(36).slice(2, 8)}`;

interface Spec {
  status?: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt?: Date;
  clientId?: string;
  email?: string | null;
  verified?: boolean;
  wallet?: boolean;
}

async function makeAccount(spec: Spec = {}) {
  const clientId = spec.clientId ?? IO;
  const email = spec.email === undefined ? `${uid()}@example.com` : spec.email;
  const account = await db!.account.create({
    data: {
      publicId: uid(),
      status: spec.status ?? "PENDING",
      createdAt: spec.createdAt ?? ago(0.01),
      identities: {
        create: [
          ...(email ? [{ scheme: "email", value: email, email, clientId, verifiedAt: spec.verified ? NOW : null }] : []),
          ...(spec.wallet === false
            ? []
            : [{ scheme: "wallet", provider: "mediawallet", chain: "STARKNET" as const, address: `0x${uid()}`, clientId, isPrimary: true }]),
        ],
      },
    },
  });
  return { id: account.id, email: email as string };
}

async function makeClient(id: string) {
  await db!.apiClient.create({ data: { id, account: { create: { publicId: uid() } } } });
}

const notices = (kind?: string) => db!.accountNotice.findMany({ where: kind ? { kind } : {} });

function sendInto(sent: Array<{ to: string; subject: string; text: string }>, ok = true) {
  return async (m: { to: string; subject: string; text: string }) => {
    if (ok) sent.push(m);
    return ok;
  };
}

const sweepDeps = (send: (m: never) => Promise<boolean>) => ({ ...deps!.productionSweepDeps(), send: send as never, now: () => NOW });

describe.skipIf(!enabled)("account notices against a real database", () => {
  beforeEach(async () => {
    await db!.$executeRawUnsafe('TRUNCATE "AccountNotice", "Identity", "ApiClient", "Account" CASCADE');
    await makeClient(IO);
    await makeClient(OTHER);
  });

  describe("the welcome email", () => {
    test("a new signup is welcomed once, and the record of it stays (the bug that dropped every welcome)", async () => {
      const { id } = await makeAccount();
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      const d = sweepDeps(sendInto(sent));
      expect(await sweep!.welcomeAccount(d, id)).toMatchObject({ due: 1, sent: 1, released: 0 });
      expect(await sweep!.welcomeAccount(d, id)).toMatchObject({ sent: 0 });
      expect(sent).toHaveLength(1);
      expect(await notices("welcome")).toHaveLength(1);
    });

    test("a send that fails leaves no record, so the next try sends it", async () => {
      const { id } = await makeAccount();
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      expect(await sweep!.welcomeAccount(sweepDeps(sendInto(sent, false)), id)).toMatchObject({ sent: 0, released: 1 });
      expect(await notices()).toHaveLength(0);
      expect(await sweep!.welcomeAccount(sweepDeps(sendInto(sent)), id)).toMatchObject({ sent: 1 });
      expect(sent).toHaveLength(1);
    });

    test("the sweep welcomes who it should, once, and nobody else", async () => {
      const newSignup = await makeAccount();
      const cameBack = await makeAccount({ status: "ACTIVE", verified: true });
      await makeAccount({ status: "ACTIVE", verified: false });
      await makeAccount({ clientId: OTHER });
      await makeAccount({ status: "INACTIVE", verified: true });
      await makeAccount({ createdAt: ago(8) });
      await makeAccount({ wallet: false });
      const already = await makeAccount();
      await db!.accountNotice.create({ data: { accountId: already.id, kind: "welcome" } });

      const sent: Array<{ to: string; subject: string; text: string }> = [];
      const d = sweepDeps(sendInto(sent));
      const first = await sweep!.sweepWelcomes(d);
      const second = await sweep!.sweepWelcomes(d);

      expect(sent.map((m) => m.to).sort()).toEqual([newSignup.email, cameBack.email].sort());
      expect(first).toMatchObject({ sent: 2 });
      expect(second).toMatchObject({ sent: 0 });
      const byTo = Object.fromEntries(sent.map((m) => [m.to, m.subject]));
      expect(byTo[newSignup.email!]).toBe("Welcome to Medialane — confirm your email");
      expect(byTo[cameBack.email!]).toBe("Welcome to Medialane");
    });
  });

  describe("the verification reminder", () => {
    test("goes to io accounts five to seven days old with a wallet and an unconfirmed email, once", async () => {
      const due = await makeAccount({ createdAt: ago(6) });
      await makeAccount({ createdAt: ago(4) });
      await makeAccount({ createdAt: ago(6), verified: true });
      await makeAccount({ createdAt: ago(6), wallet: false });
      await makeAccount({ createdAt: ago(6), clientId: OTHER });
      await makeAccount({ createdAt: ago(6), status: "ACTIVE" });
      await makeAccount({ createdAt: ago(8) });

      const sent: Array<{ to: string; subject: string; text: string }> = [];
      const d = sweepDeps(sendInto(sent));
      expect(await sweep!.sweepReminders(d)).toMatchObject({ due: 1, sent: 1 });
      expect(await sweep!.sweepReminders(d)).toMatchObject({ sent: 0 });
      expect(sent.map((m) => m.to)).toEqual([due.email]);
      expect(sent[0]!.text).toContain("confirm-email?token=");
      expect(await notices("verification-reminder")).toHaveLength(1);
    });

    test("an account confirmed after it was picked is not reminded and keeps no record", async () => {
      const { id } = await makeAccount({ createdAt: ago(6) });
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      const d = { ...sweepDeps(sendInto(sent)), stillUnverified: async () => false };
      expect(await sweep!.sweepReminders(d)).toMatchObject({ sent: 0, skipped: 1 });
      expect(sent).toHaveLength(0);
      expect(await notices()).toHaveLength(0);
      expect(id).toBeTruthy();
    });
  });

  describe("the notice ledger", () => {
    test("a notice can be claimed once, released, and claimed again", async () => {
      const { id } = await makeAccount();
      const store = deps!.prismaNoticeStore;
      expect(await store.claim(id, "welcome")).toBe(true);
      expect(await store.claim(id, "welcome")).toBe(false);
      await store.release(id, "welcome");
      expect(await store.claim(id, "welcome")).toBe(true);
    });
  });

  describe("closing accounts that never confirmed", () => {
    test("only io's pending accounts older than seven days are closed", async () => {
      const closing = await makeAccount({ createdAt: ago(8) });
      const otherClient = await makeAccount({ createdAt: ago(8), clientId: OTHER });
      const provisioned = await makeAccount({ status: "ACTIVE", createdAt: ago(30), verified: false });
      const recent = await makeAccount({ createdAt: ago(2) });

      expect(await expiry!.deactivateExpiredPending(NOW, db as never, IO)).toBe(1);
      const status = async (id: string) => (await db!.account.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(closing.id)).toBe("INACTIVE");
      expect(await status(otherClient.id)).toBe("PENDING");
      expect(await status(provisioned.id)).toBe("ACTIVE");
      expect(await status(recent.id)).toBe("PENDING");
    });
  });

  describe("the welcome backfill", () => {
    const sql = readFileSync(join(import.meta.dir, "../../prisma/migrations/20261003140000_welcome_backfill/migration.sql"), "utf8");

    test("records the welcome as sent for accounts that have a wallet, and only those, and can run twice", async () => {
      const withWallet = await makeAccount();
      const noWallet = await makeAccount({ wallet: false });
      await db!.$executeRawUnsafe(sql);
      await db!.$executeRawUnsafe(sql);
      const rows = await notices("welcome");
      expect(rows.map((r) => r.accountId)).toEqual([withWallet.id]);
      expect(rows.some((r) => r.accountId === noWallet.id)).toBe(false);
    });
  });
});
