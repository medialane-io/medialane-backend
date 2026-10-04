import type { AuthEmailDeps } from "../api/routes/auth-email.js";

export async function verifyAndActivate(
  deps: Pick<AuthEmailDeps, "markEmailVerified" | "activateAccount">,
  accountId: string,
  email: string,
  clientId: string,
): Promise<void> {
  await deps.markEmailVerified(email, clientId);
  await deps.activateAccount(accountId);
}
