import { expect, test } from "bun:test";
import { SUPPORT_EMAIL, sendSupportRequest } from "./supportRequest";
import type { EmailMessage } from "../utils/mailer";

const wallets = [{ address: "0x1", active: false }, { address: "0x2", active: true }];

function deps(email: string | null, delivered = true) {
  const sent: EmailMessage[] = [];
  return {
    sent,
    deps: {
      emailOf: async () => email,
      walletsOf: async () => wallets,
      send: async (message: EmailMessage) => (sent.push(message), delivered),
    },
  };
}

test("goes to the support address, answerable at the account email, with every wallet", async () => {
  const { sent, deps: d } = deps("a@b.co");
  expect(await sendSupportRequest(d, "acc1", "  help  ")).toBe(true);
  expect(sent).toEqual([
    { to: SUPPORT_EMAIL, replyTo: "a@b.co", template: "support-request", data: { accountEmail: "a@b.co", wallets, message: "help" } },
  ]);
});

test("an empty note is sent as no message, and an account without an email has no reply address", async () => {
  const { sent, deps: d } = deps(null);
  await sendSupportRequest(d, "acc1", "   ");
  expect(sent[0]!.replyTo).toBeUndefined();
  expect(sent[0]).toMatchObject({ data: { accountEmail: null, message: null } });
  await sendSupportRequest(d, "acc1", undefined);
  expect(sent[1]).toMatchObject({ data: { message: null } });
});

test("reports false when the email was not delivered", async () => {
  expect(await sendSupportRequest(deps("a@b.co", false).deps, "acc1", "help")).toBe(false);
});
