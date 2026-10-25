import { describe, expect, test } from "bun:test";
import { shortString } from "starknet";
import { decodeText } from "./text.js";

const toHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") || "0"}`;

function byteArrayFelts(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const words: string[] = [];
  let i = 0;
  for (; i + 31 <= bytes.length; i += 31) words.push(toHex(bytes.slice(i, i + 31)));
  const pending = bytes.slice(i);
  return [`0x${words.length.toString(16)}`, ...words, toHex(pending), `0x${pending.length.toString(16)}`];
}

describe("decodeText: ByteArray", () => {
  test("a short string", () => {
    expect(decodeText(byteArrayFelts("hello"))).toBe("hello");
  });

  test("a string longer than one 31-byte word", () => {
    const uri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json";
    expect(decodeText(byteArrayFelts(uri))).toBe(uri);
  });

  test("multi-byte characters survive", () => {
    expect(decodeText(byteArrayFelts("héllo wörld ✓ ünïcode"))).toBe("héllo wörld ✓ ünïcode");
  });

  test("an empty string", () => {
    expect(decodeText(["0x0", "0x0", "0x0"])).toBe("");
  });

  test("a pending length over 31 is refused", () => {
    expect(decodeText(["0x0", "0x1", "0x20"])).toBeNull();
  });

  test("a data length that does not fit the response is refused", () => {
    expect(decodeText(["0x5", "0x1", "0x0", "0x0"])).toBeNull();
  });
});

describe("decodeText: older shapes", () => {
  test("a felt array of short strings is joined", () => {
    const a = "ipfs://aaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "bbbb";
    expect(decodeText(["0x2", shortString.encodeShortString(a), shortString.encodeShortString(b)])).toBe(a + b);
  });

  test("a single short-string felt", () => {
    expect(decodeText([shortString.encodeShortString("MyName")])).toBe("MyName");
  });

  test("a ByteArray is read as text", () => {
    expect(decodeText(byteArrayFelts("hello"))).toBe("hello");
  });
});

describe("decodeText: nothing to decode", () => {
  test("an empty response is null", () => {
    expect(decodeText([])).toBeNull();
  });
});
