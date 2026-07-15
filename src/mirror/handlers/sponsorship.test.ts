// FeltCursor is the trickiest part of sponsorship event decoding (u256/
// bool/address/ByteArray/Option all mixed in one struct, manually offset —
// same class of bug as the ByteArray mojibake incidents in
// collectionCreated.ts/ip1155Factory.ts). These are pure decode tests, no DB
// — this repo's test env has no live Postgres (see CLAUDE.md), so handler
// tests that need a database are out of scope here; the highest-leverage
// coverage is the manual felt math itself.
import { describe, expect, test } from "bun:test";
import { FeltCursor } from "./sponsorship.js";

/** Encodes a UTF-8 string the same way Cairo's ByteArray serde does:
 *  [data_len, ...31-byte words, pending_word, pending_word_len]. */
function encodeByteArrayFelts(str: string): string[] {
  const bytes = new TextEncoder().encode(str);
  const dataLen = Math.floor(bytes.length / 31);
  const pendingLen = bytes.length % 31;
  const felts: string[] = [`0x${dataLen.toString(16)}`];
  for (let w = 0; w < dataLen; w++) {
    let word = 0n;
    for (let j = 0; j < 31; j++) word = (word << 8n) | BigInt(bytes[w * 31 + j]);
    felts.push(`0x${word.toString(16)}`);
  }
  let pending = 0n;
  for (let j = 0; j < pendingLen; j++) pending = (pending << 8n) | BigInt(bytes[dataLen * 31 + j]);
  felts.push(`0x${pending.toString(16)}`, `0x${pendingLen.toString(16)}`);
  return felts;
}

describe("FeltCursor", () => {
  test("u256 combines low/high across the 128-bit boundary", () => {
    // 2^128 + 5 — a value that only round-trips correctly if high/low aren't swapped.
    const cursor = new FeltCursor(["0x5", "0x1"]);
    expect(cursor.u256()).toBe((2n ** 128n + 5n).toString());
  });

  test("u64 reads a plain felt as a number", () => {
    const cursor = new FeltCursor(["0x15180"]); // 86400 (one day, seconds)
    expect(cursor.u64()).toBe(86400);
  });

  test("bool: nonzero is true, zero is false", () => {
    expect(new FeltCursor(["0x1"]).bool()).toBe(true);
    expect(new FeltCursor(["0x0"]).bool()).toBe(false);
  });

  test("address normalizes to a padded 64-char hex string", () => {
    const cursor = new FeltCursor(["0xabc"]);
    expect(cursor.address()).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000abc",
    );
  });

  test("optionAddress: variant 0 (Some) reads the following address", () => {
    const cursor = new FeltCursor(["0x0", "0xdef"]);
    expect(cursor.optionAddress()).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000def",
    );
  });

  test("optionAddress: variant 1 (None) consumes only the variant felt", () => {
    const cursor = new FeltCursor(["0x1", "0xdef"]);
    expect(cursor.optionAddress()).toBe(null);
    // The address felt was NOT consumed as part of the Option — next read sees it.
    expect(cursor.address()).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000def",
    );
  });

  test("byteArray round-trips a short ASCII string (pending word only, no full words)", () => {
    const felts = encodeByteArrayFelts("ipfs://short-cid");
    expect(new FeltCursor(felts).byteArray()).toBe("ipfs://short-cid");
  });

  test("byteArray round-trips a string spanning a full 31-byte word plus a pending word", () => {
    const str = "ipfs://" + "a".repeat(40); // > 31 bytes forces at least one full word
    const felts = encodeByteArrayFelts(str);
    expect(new FeltCursor(felts).byteArray()).toBe(str);
  });

  test("byteArray round-trips multi-byte UTF-8 without mojibake", () => {
    // The exact bug class from the 2026-06-28 collectionCreated.ts incident —
    // String.fromCharCode on raw bytes mangles multi-byte sequences.
    const str = "license terms — 商標 ó";
    const felts = encodeByteArrayFelts(str);
    expect(new FeltCursor(felts).byteArray()).toBe(str);
  });

  test("sequential reads advance the cursor correctly across mixed field types", () => {
    // Mirrors OfferCreated's data tail: transferable(bool), royalty_bps(u256), then an address.
    const cursor = new FeltCursor(["0x1", "0x1f4", "0x0", "0xabc"]);
    expect(cursor.bool()).toBe(true);
    expect(cursor.u256()).toBe("500");
    expect(cursor.address()).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000abc",
    );
  });
});
