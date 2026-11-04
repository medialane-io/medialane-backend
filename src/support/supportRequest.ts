import type { EmailMessage } from "../utils/mailer.js";

export const SUPPORT_EMAIL = "dao@medialane.org";

export interface SupportDeps {
  emailOf(accountId: string): Promise<string | null>;
  walletsOf(accountId: string): Promise<{ address: string; active: boolean }[]>;
  send(message: EmailMessage): Promise<boolean>;
}

export async function sendSupportRequest(deps: SupportDeps, accountId: string, message: string | undefined): Promise<boolean> {
  const [accountEmail, wallets] = await Promise.all([deps.emailOf(accountId), deps.walletsOf(accountId)]);
  return deps.send({
    to: SUPPORT_EMAIL,
    replyTo: accountEmail ?? undefined,
    template: "support-request",
    data: { accountEmail, wallets, message: message?.trim() || null },
  });
}
