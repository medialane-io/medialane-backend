import { describe, expect, test } from "bun:test";
import { sweepReminders, type NoticeStore, type ReminderCandidate, type SweepDeps } from "./sweep";
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

function setup(candidates: ReminderCandidate[], overrides: Partial<SweepDeps> = {}) {
  const sent: EmailMessage[] = [];
  const { store, held } = memoryStore();
  const limits: number[] = [];
  const deps: SweepDeps = {
    findReminderCandidates: async (_now, limit) => {
      limits.push(limit);
      return candidates;
    },
    stillUnverified: async () => true,
    store,
    send: async (message) => {
      sent.push(message);
      return true;
    },
    confirmUrl: (id, _email, deadline) => `https://www.medialane.io/confirm-email?token=${id}.${deadline.getTime()}`,
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
    expect(sent[0]!.text).toContain("confirm-email?token=a.");
    expect(sent[0]!.subject).toContain("Confirm your email by");
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
