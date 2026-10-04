export const DAY_MS = 24 * 60 * 60 * 1000;

export const IO_VERIFICATION_DAYS = 7;
export const VERIFICATION_REMINDER_DAYS_BEFORE = 2;
export const VERIFICATION_REMINDER_AFTER_DAYS = IO_VERIFICATION_DAYS - VERIFICATION_REMINDER_DAYS_BEFORE;

export const verificationDeadline = (createdAt: Date, days: number = IO_VERIFICATION_DAYS): Date =>
  new Date(createdAt.getTime() + days * DAY_MS);

export const reminderOpensAt = (createdAt: Date): Date => verificationDeadline(createdAt, VERIFICATION_REMINDER_AFTER_DAYS);
