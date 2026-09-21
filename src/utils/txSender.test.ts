import { describe, expect, test } from "bun:test";
import { sentBySomeoneElse } from "./txVerifier.js";

const REQUESTER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SOMEONE_ELSE = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";

describe("whose transaction may settle an intent", () => {
  test("the wallet the intent was built for may settle it", () => {
    expect(sentBySomeoneElse(REQUESTER, REQUESTER)).toBe(false);
  });

  test("the same wallet written unpadded is still that wallet", () => {
    const unpadded = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(sentBySomeoneElse(unpadded, REQUESTER)).toBe(false);
  });

  test("another wallet may not", () => {
    expect(sentBySomeoneElse(SOMEONE_ELSE, REQUESTER)).toBe(true);
  });

  test("a sender that could not be read is not held against the intent", () => {
    expect(sentBySomeoneElse(null, REQUESTER)).toBe(false);
  });
});
