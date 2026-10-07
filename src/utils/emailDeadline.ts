import { verificationDeadline } from "../orchestrator/unverifiedAccounts.js";

export function emailDeadlineFor(input: {
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt: Date;
  hasEmail: boolean;
}): Date | null {
  if (input.status !== "PENDING" || !input.hasEmail) return null;
  return verificationDeadline(input.createdAt);
}
