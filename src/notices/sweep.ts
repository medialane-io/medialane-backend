import type { EmailMessage } from "../utils/mailer.js";
import { buildReminderEmail } from "../utils/reminderEmail.js";
import { verificationDeadline } from "../utils/accountLifecycle.js";
import { reminderDue, type ReminderFacts } from "./rules.js";

export type NoticeKind = "verification-reminder";

export interface NoticeStore {
  claim(accountId: string, kind: NoticeKind): Promise<boolean>;
  release(accountId: string, kind: NoticeKind): Promise<void>;
}

export interface ReminderCandidate {
  accountId: string;
  email: string;
  createdAt: Date;
  facts: ReminderFacts;
}

export interface SweepDeps {
  findReminderCandidates(now: Date, limit: number): Promise<ReminderCandidate[]>;
  stillUnverified(accountId: string): Promise<boolean>;
  store: NoticeStore;
  send(message: EmailMessage): Promise<boolean>;
  confirmUrl(accountId: string, email: string, deadline: Date): string;
  now(): Date;
  mode: "dry-run" | "live";
  batchLimit: number;
}

export interface SweepResult {
  due: number;
  sent: number;
  released: number;
  skipped: number;
  wouldSend: string[];
}

const KIND: NoticeKind = "verification-reminder";

export async function sweepReminders(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now();
  const result: SweepResult = { due: 0, sent: 0, released: 0, skipped: 0, wouldSend: [] };

  for (const candidate of await deps.findReminderCandidates(now, deps.batchLimit)) {
    if (!reminderDue(candidate.facts, now)) {
      result.skipped += 1;
      continue;
    }
    result.due += 1;

    if (deps.mode === "dry-run") {
      result.wouldSend.push(candidate.accountId);
      continue;
    }

    if (!(await deps.store.claim(candidate.accountId, KIND))) {
      result.skipped += 1;
      continue;
    }

    if (!(await deps.stillUnverified(candidate.accountId))) {
      await deps.store.release(candidate.accountId, KIND);
      result.skipped += 1;
      continue;
    }

    const deadline = verificationDeadline(candidate.createdAt);
    const email = buildReminderEmail({ confirmUrl: deps.confirmUrl(candidate.accountId, candidate.email, deadline), deadline });
    let delivered = false;
    try {
      delivered = await deps.send({ to: candidate.email, ...email });
    } catch {
      delivered = false;
    }

    if (delivered) {
      result.sent += 1;
    } else {
      await deps.store.release(candidate.accountId, KIND);
      result.released += 1;
    }
  }

  return result;
}
