import { describe, expect, test } from "bun:test";
import { readTextCapped } from "./httpBody.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function resOf(chunks: string[], contentLength?: number) {
  return {
    headers: { get: (n: string) => (n.toLowerCase() === "content-length" && contentLength != null ? String(contentLength) : null) },
    body: streamOf(chunks),
  };
}

describe("readTextCapped", () => {
  test("returns full body when under the cap", async () => {
    const { text, truncated } = await readTextCapped(resOf(['{"a":', "1}"]), 1024);
    expect(text).toBe('{"a":1}');
    expect(truncated).toBe(false);
  });

  test("truncates a body that exceeds the cap mid-chunk", async () => {
    const { text, truncated } = await readTextCapped(resOf(["abcdefghij"]), 4);
    expect(text).toBe("abcd");
    expect(truncated).toBe(true);
  });

  test("truncates across chunk boundaries", async () => {
    const { text, truncated } = await readTextCapped(resOf(["abc", "def", "ghi"]), 5);
    expect(text).toBe("abcde");
    expect(truncated).toBe(true);
  });

  test("short-circuits on an oversized Content-Length without reading", async () => {
    const { text, truncated } = await readTextCapped(resOf(["ignored"], 10_000_000), 1024);
    expect(text).toBe("");
    expect(truncated).toBe(true);
  });

  test("handles a null body", async () => {
    const { text, truncated } = await readTextCapped({ headers: { get: () => null }, body: null }, 1024);
    expect(text).toBe("");
    expect(truncated).toBe(false);
  });
});
