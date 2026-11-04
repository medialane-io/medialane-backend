import { describe, expect, test } from "bun:test";
import { htmlToText, renderTemplate, type TemplateRequest } from "./mailTemplates";

const APP = "https://www.medialane.io";
const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "eyJwIjoiYSJ9.abc-DEF_123";
const DEADLINE = "2026-10-10T12:00:00.000Z";

const render = (request: TemplateRequest) => renderTemplate(request, APP);
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe("the emails", () => {
  test("verification code: carries the code and its lifetime in both parts", () => {
    const { subject, html, text } = render({ template: "verification-code", data: { code: "482913" } });
    expect(subject).toBe("Your verification code");
    for (const body of [html, text]) {
      expect(body).toContain("482913");
      expect(body).toContain("10 minutes");
    }
    expect(text).toContain("If you didn't request this");
  });

  test("reminder: names the date, says what happens, links only to confirm", () => {
    const { subject, html, text } = render({ template: "verification-reminder", data: { confirmToken: TOKEN, deadline: new Date(DEADLINE) } });
    expect(subject).toBe("Confirm your email by 10 October to keep your Medialane account");
    for (const body of [html, text]) expect(body).toContain("10 October 2026");
    expect(text).toContain("cannot be reopened");
    expect(links(html)).toEqual([`${APP}/confirm-email#token=${TOKEN}`]);
    expect(`${html}${text}`.toLowerCase()).not.toContain("starknet");
  });

  test("guardian alerts show a short address, never the full one", () => {
    const cases: TemplateRequest[] = [
      { template: "guardian-set", data: { walletAddress: ADDRESS } },
      { template: "guardian-escape-triggered", data: { walletAddress: ADDRESS, readyAt: new Date(DEADLINE) } },
      { template: "guardian-escape-completed", data: { walletAddress: ADDRESS } },
    ];
    for (const request of cases) {
      const { subject, html, text } = render(request);
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toContain("0x0123…cdef");
      expect(html).not.toContain(ADDRESS);
      expect(text).not.toContain("<");
    }
    expect(render(cases[1]!).html).toContain(new Date(DEADLINE).toUTCString());
  });

  test("the only links an email can contain point at the app", () => {
    const all: TemplateRequest[] = [
      { template: "verification-reminder", data: { confirmToken: TOKEN, deadline: new Date(DEADLINE) } },
      { template: "guardian-set", data: { walletAddress: ADDRESS } },
    ];
    for (const request of all) for (const link of links(render(request).html)) expect(link!.startsWith(`${APP}/`)).toBe(true);
  });
});

describe("the plain-text part", () => {
  test("keeps the words and drops the tags", () => {
    expect(htmlToText("<p>Hello <strong>there</strong></p>")).toBe("Hello there");
  });
  test("puts paragraphs and breaks on their own lines", () => {
    expect(htmlToText("<p>One</p><p>Two<br/>Three</p>")).toBe("One\nTwo\nThree");
  });
  test("decodes the entities the templates use and drops style and script", () => {
    expect(htmlToText("<style>p{}</style><script>x</script><p>A &rsaquo; B &amp; C &quot;d&quot;</p>")).toBe('A > B & C "d"');
  });
});

describe("the support request email", () => {
  const request: TemplateRequest = {
    template: "support-request",
    data: {
      accountEmail: "a@b.co",
      wallets: [{ address: ADDRESS, active: false }, { address: "0x0abc", active: true }],
      message: "I <b>lost</b> my key",
    },
  };

  test("names the account, every wallet in full and the message", () => {
    const { subject, html, text } = render(request);
    expect(subject).toBe("Support request");
    for (const body of [html, text]) {
      expect(body).toContain("a@b.co");
      expect(body).toContain(`${ADDRESS} (earlier)`);
      expect(body).toContain("0x0abc (current)");
    }
  });

  test("shows the message as text, never as markup", () => {
    const { html } = render(request);
    expect(html).toContain("I &lt;b&gt;lost&lt;/b&gt; my key");
    expect(html).not.toContain("<b>lost</b>");
  });

  test("says so when there is no message or no email", () => {
    const { text } = render({ template: "support-request", data: { accountEmail: null, wallets: [], message: null } });
    expect(text).toContain("No message");
    expect(text).toContain("none");
  });
});
