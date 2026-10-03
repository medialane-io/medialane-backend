import { describe, expect, test } from "bun:test";
import {
  needsAttention,
  sweepReminders,
  sweepWelcomes,
  welcomeAccount,
  type NoticeStore,
  type ReminderCandidate,
  type SweepDeps,
  type WelcomeCandidate,
} from "./sweep";
import type { EmailMessage } from "../utils/mailer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");

const candidate = (id: string, ageDays = 5): ReminderCandidate => ({
  accountId: id,
  email: `${id}@example.com`,
  createdAt: new Date(NOW.getTime() - ageDays * DAY),
  facts: {
    status: "PENDING",
    createdAt: new Date(NOW.getTime() - ageDays * DAY),
    isIo: true,
    hasEmail: true,
    emailVerified: false,
    hasWallet: true,
  },
});

function memoryStore() {
  const held = new Set<string>();
  const store: NoticeStore = {
    claim: async (id, kind) => {
      const key = `${id}:${kind}`;
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    release: async (id, kind) => void held.delete(`${id}:${kind}`),
  };
  return { store, held };
}

function setup(candidates: ReminderCandidate[], overrides: Partial<SweepDeps> = {}, welcomes: WelcomeCandidate[] = []) {
  const sent: EmailMessage[] = [];
  const { store, held } = memoryStore();
  const limits: number[] = [];
  const deps: SweepDeps = {
    findReminderCandidates: async (_now, limit) => {
      limits.push(limit);
      return candidates;
    },
    stillUnverified: async () => true,
    findWelcomeCandidates: async () => welcomes,
    loadWelcomeCandidate: async (id) => welcomes.find((w) => w.accountId === id) ?? null,
    store,
    send: async (message) => {
      sent.push(message);
      return true;
    },
    confirmToken: (id, _email, deadline) => `${id}.${deadline.getTime()}`,
    now: () => NOW,
    batchLimit: 200,
    ...overrides,
  };
  return { deps, sent, held, limits };
}

describe("sending the verification reminder", () => {
  test("a due account is sent one reminder, to its email, with a link that expires at the deadline", async () => {
    const { deps, sent } = setup([candidate("a")]);
    const result = await sweepReminders(deps);
    expect(result).toMatchObject({ due: 1, sent: 1, released: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("a@example.com");
    expect(sent[0]).toMatchObject({ template: "verification-reminder" });
    const data = (sent[0] as Extract<EmailMessage, { template: "verification-reminder" }>).data;
    expect(data.confirmToken).toBe(`a.${data.deadline.getTime()}`);
    expect(data.deadline.getTime()).toBe(NOW.getTime() + 2 * DAY);
  });

  test("a second sweep does not send it again", async () => {
    const { deps, sent } = setup([candidate("a")]);
    await sweepReminders(deps);
    const second = await sweepReminders(deps);
    expect(sent).toHaveLength(1);
    expect(second.sent).toBe(0);
  });

  test("two sweeps running at the same moment send it once", async () => {
    const { deps, sent } = setup([candidate("a")]);
    await Promise.all([sweepReminders(deps), sweepReminders(deps)]);
    expect(sent).toHaveLength(1);
  });

  test("a send that fails gives the account back, and the next sweep retries it", async () => {
    let attempts = 0;
    const { deps, sent, held } = setup([candidate("a")], {
      send: async (message) => {
        attempts += 1;
        if (attempts === 1) return false;
        sent.push(message);
        return true;
      },
    });
    const first = await sweepReminders(deps);
    expect(first).toMatchObject({ sent: 0, released: 1 });
    expect(held.size).toBe(0);
    const second = await sweepReminders(deps);
    expect(second.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test("a send that throws is released too, and the other accounts are still sent", async () => {
    const { deps, sent } = setup([candidate("a"), candidate("b")], {
      send: async (message) => {
        if (message.to.startsWith("a@")) throw new Error("relay down");
        sent.push(message);
        return true;
      },
    });
    const result = await sweepReminders(deps);
    expect(result).toMatchObject({ sent: 1, released: 1 });
    expect(sent.map((m) => m.to)).toEqual(["b@example.com"]);
  });

  test("an account confirmed between selection and sending gets nothing and keeps no claim", async () => {
    const { deps, sent, held } = setup([candidate("a")], { stillUnverified: async () => false });
    const result = await sweepReminders(deps);
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
    expect(held.size).toBe(0);
  });

  test("an account the rule no longer accepts is skipped, even if the query returned it", async () => {
    const { deps, sent } = setup([candidate("young", 3), candidate("old", 8)]);
    const result = await sweepReminders(deps);
    expect(result).toMatchObject({ due: 0, sent: 0, skipped: 2 });
    expect(sent).toHaveLength(0);
  });

  test("asks for no more accounts than the batch limit", async () => {
    const { deps, limits } = setup([], { batchLimit: 50 });
    await sweepReminders(deps);
    expect(limits).toEqual([50]);
  });
});

const WALLET = "0x01575d29b83d7828cd1d833ef785083b809adeb187b6ac14aab21db568f2bf02";
const welcomeCandidate = (id: string, over: Partial<WelcomeCandidate["facts"]> = {}): WelcomeCandidate => ({
  accountId: id,
  email: `${id}@example.com`,
  walletAddress: WALLET,
  createdAt: new Date(NOW.getTime() - 0.01 * DAY),
  facts: {
    status: "PENDING",
    createdAt: new Date(NOW.getTime() - 0.01 * DAY),
    isIo: true,
    hasEmail: true,
    emailVerified: false,
    hasWallet: true,
    ...over,
  },
});

describe("sending the welcome email", () => {
  test("a first-try signup is welcomed with the confirm link and the deadline, and the wallet address", async () => {
    const { deps, sent } = setup([], {}, [welcomeCandidate("a")]);
    const result = await sweepWelcomes(deps);
    expect(result).toMatchObject({ due: 1, sent: 1 });
    expect(sent[0]!.to).toBe("a@example.com");
    expect(sent[0]).toMatchObject({ template: "welcome", data: { walletAddress: WALLET } });
    const confirm = (sent[0] as Extract<EmailMessage, { template: "welcome" }>).data.confirm;
    expect(confirm?.token.startsWith("a.")).toBe(true);
    expect(confirm!.deadline.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("someone who came back with a code gets the plain welcome, with no confirm link", async () => {
    const { deps, sent } = setup([], {}, [welcomeCandidate("b", { status: "ACTIVE", emailVerified: true })]);
    await sweepWelcomes(deps);
    expect(sent[0]).toMatchObject({ template: "welcome", data: { walletAddress: WALLET, confirm: null } });
  });

  test("a provisioned account that has not signed in yet is not welcomed", async () => {
    const { deps, sent } = setup([], {}, [welcomeCandidate("p", { status: "ACTIVE", emailVerified: false })]);
    const result = await sweepWelcomes(deps);
    expect(result).toMatchObject({ due: 0, sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
  });

  test("an account is welcomed once, however many sweeps or immediate sends happen", async () => {
    const { deps, sent } = setup([], {}, [welcomeCandidate("a")]);
    await sweepWelcomes(deps);
    await sweepWelcomes(deps);
    await welcomeAccount(deps, "a");
    await Promise.all([welcomeAccount(deps, "a"), sweepWelcomes(deps)]);
    expect(sent).toHaveLength(1);
  });

  test("the immediate send for one account welcomes it right away", async () => {
    const { deps, sent } = setup([], {}, [welcomeCandidate("a")]);
    const result = await welcomeAccount(deps, "a");
    expect(result).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  test("the immediate send for an account that does not qualify, or does not exist, sends nothing", async () => {
    const { deps, sent } = setup([], {}, [welcomeCandidate("closed", { status: "INACTIVE" })]);
    expect(await welcomeAccount(deps, "closed")).toMatchObject({ sent: 0 });
    expect(await welcomeAccount(deps, "nobody")).toMatchObject({ sent: 0, due: 0 });
    expect(sent).toHaveLength(0);
  });

  test("a failed send is released and the next sweep welcomes them (the outage retry)", async () => {
    let up = false;
    const { deps, sent } = setup([], { send: async (m) => (up ? (sent.push(m), true) : false) }, [welcomeCandidate("a")]);
    expect(await sweepWelcomes(deps)).toMatchObject({ sent: 0, released: 1 });
    up = true;
    expect(await sweepWelcomes(deps)).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });
});

describe("when a result is worth a warning in the log", () => {
  test("a notice that was due but not sent is, and so is one that had to be given back", () => {
    expect(needsAttention({ due: 1, sent: 0, released: 0, skipped: 0 })).toBe(true);
    expect(needsAttention({ due: 1, sent: 0, released: 1, skipped: 0 })).toBe(true);
    expect(needsAttention({ due: 2, sent: 1, released: 1, skipped: 0 })).toBe(true);
  });

  test("a notice that was sent, or was never due, is not", () => {
    expect(needsAttention({ due: 1, sent: 1, released: 0, skipped: 0 })).toBe(false);
    expect(needsAttention({ due: 0, sent: 0, released: 0, skipped: 3 })).toBe(false);
    expect(needsAttention({ due: 0, sent: 0, released: 0, skipped: 0 })).toBe(false);
  });
});
