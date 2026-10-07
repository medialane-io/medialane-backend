import type { EmailMessage, EmailTemplate } from "../utils/mailer.js";
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
  stillPending(accountId: string): Promise<boolean>;
  store: NoticeStore;
  send(message: EmailMessage): Promise<boolean>;
  confirmToken(accountId: string, email: string, deadline: Date): string;
  now(): Date;
  batchLimit: number;
}

export interface SweepResult {
  due: number;
  sent: number;
  released: number;
  skipped: number;
}

interface Pipeline<C extends { accountId: string; email: string }> {
  kind: NoticeKind;
  due(candidate: C, now: Date): boolean;
  recheck(candidate: C): Promise<boolean>;
  message(candidate: C): EmailTemplate;
}

export const needsAttention = (result: SweepResult): boolean =>
  result.released > 0 || (result.due > 0 && result.sent === 0);

async function run<C extends { accountId: string; email: string }>(
  pipeline: Pipeline<C>,
  candidates: C[],
  deps: SweepDeps,
): Promise<SweepResult> {
  const now = deps.now();
  const result: SweepResult = { due: 0, sent: 0, released: 0, skipped: 0 };

  for (const candidate of candidates) {
    if (!pipeline.due(candidate, now)) {
      result.skipped += 1;
      continue;
    }
    result.due += 1;

    if (!(await deps.store.claim(candidate.accountId, pipeline.kind))) {
      result.skipped += 1;
      continue;
    }

    if (!(await pipeline.recheck(candidate))) {
      await deps.store.release(candidate.accountId, pipeline.kind);
      result.skipped += 1;
      continue;
    }

    let delivered = false;
    try {
      delivered = await deps.send({ ...pipeline.message(candidate), to: candidate.email });
    } catch {
      delivered = false;
    }

    if (delivered) {
      result.sent += 1;
    } else {
      await deps.store.release(candidate.accountId, pipeline.kind);
      result.released += 1;
    }
  }

  return result;
}

const reminderPipeline = (deps: SweepDeps): Pipeline<ReminderCandidate> => ({
  kind: "verification-reminder",
  due: (candidate, now) => reminderDue(candidate.facts, now),
  recheck: (candidate) => deps.stillPending(candidate.accountId),
  message: (candidate) => {
    const deadline = verificationDeadline(candidate.createdAt);
    return {
      template: "verification-reminder",
      data: { confirmToken: deps.confirmToken(candidate.accountId, candidate.email, deadline), deadline },
    };
  },
});

export async function sweepReminders(deps: SweepDeps): Promise<SweepResult> {
  return run(reminderPipeline(deps), await deps.findReminderCandidates(deps.now(), deps.batchLimit), deps);
}
