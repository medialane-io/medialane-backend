import { describe, expect, test } from "bun:test";
import { htmlToText } from "./emailText";

describe("turning an email's html into its plain-text part", () => {
  test("keeps the words and drops the tags", () => {
    expect(htmlToText("<p>Hello <strong>there</strong></p>")).toBe("Hello there");
  });

  test("puts paragraphs and breaks on their own lines", () => {
    expect(htmlToText("<p>One</p><p>Two<br/>Three</p>")).toBe("One\nTwo\nThree");
  });

  test("decodes the entities the templates use", () => {
    expect(htmlToText("<p>Settings &rsaquo; Security &amp; Recovery &quot;ok&quot; &lt;b&gt;</p>")).toBe('Settings > Security & Recovery "ok" <b>');
  });

  test("drops style and script blocks entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><script>alert(1)</script><p>Hi</p>")).toBe("Hi");
  });

  test("tidies runs of blank space", () => {
    expect(htmlToText("<div>  A  </div>\n\n\n\n<div>B</div>")).toBe("A\n\nB");
  });
});
