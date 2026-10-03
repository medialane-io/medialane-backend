import { VERIFICATION_REMINDER_AFTER_DAYS, IO_VERIFICATION_DAYS, DAY_MS } from "../utils/accountLifecycle.js";

export interface ReminderFacts {
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt: Date;
  isIo: boolean;
  hasEmail: boolean;
  emailVerified: boolean;
  hasWallet: boolean;
}

export function reminderDue(facts: ReminderFacts, now: Date): boolean {
  if (facts.status !== "PENDING" || !facts.isIo || !facts.hasEmail || facts.emailVerified || !facts.hasWallet) return false;
  const age = now.getTime() - facts.createdAt.getTime();
  return age >= VERIFICATION_REMINDER_AFTER_DAYS * DAY_MS && age < IO_VERIFICATION_DAYS * DAY_MS;
}
