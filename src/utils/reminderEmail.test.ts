import { describe, expect, test } from "bun:test";
import { buildReminderEmail } from "./reminderEmail";

const input = {
  confirmUrl: "https://www.medialane.io/confirm-email#token=abc.def&x=1",
  deadline: new Date("2026-10-10T12:00:00Z"),
};

describe("the reminder email", () => {
  test("names the date and asks to confirm, in the subject", () => {
    expect(buildReminderEmail(input).subject).toBe("Confirm your email by 10 October to keep your Medialane account");
  });

  test("carries the confirm link and the date in both html and text", () => {
    const { html, text } = buildReminderEmail(input);
    expect(text).toContain(input.confirmUrl);
    expect(html).toContain("token=abc.def&amp;x=1");
    for (const body of [html, text]) expect(body).toContain("10 October 2026");
  });

  test("says plainly what happens if it is not confirmed", () => {
    const { text } = buildReminderEmail(input);
    expect(text).toContain("closed");
    expect(text).toContain("cannot be reopened");
  });

  test("never mentions the chain, and its only link is the confirm button", () => {
    const { html, text } = buildReminderEmail(input);
    expect(`${html}${text}`.toLowerCase()).not.toContain("starknet");
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual([input.confirmUrl.replace(/&/g, "&amp;")]);
  });

  test("escapes what it puts in the page", () => {
    const { html } = buildReminderEmail({ ...input, confirmUrl: `https://x.io/?a="><script>x</script>` });
    expect(html).not.toContain("<script>");
  });
});
