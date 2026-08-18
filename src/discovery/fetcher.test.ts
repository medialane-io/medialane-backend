import { describe, expect, test } from "bun:test";
import { fetchJson } from "./fetcher.js";

function mockFetchOnce(responses: Record<string, Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const res = responses[url];
    if (!res) throw new Error(`Unexpected fetch to ${url}`);
    return res;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("fetchJson data: URI handling", () => {
  test("decodes a base64 data:application/json URI", async () => {
    const json = JSON.stringify({ name: "Foo", attributes: [{ trait_type: "A", value: "1" }] });
    const uri = `data:application/json;base64,${Buffer.from(json, "utf-8").toString("base64")}`;
    const result = await fetchJson(uri);
    expect(result).toEqual({ name: "Foo", attributes: [{ trait_type: "A", value: "1" }] });
  });

  test("decodes a RAW (non-base64) data:application/json URI with a comma in the payload", async () => {

    const uri = `data:application/json,${encodeURIComponent(
      JSON.stringify({ name: "Lifeform 1", attributes: [{ trait_type: "Kind", value: "Loop" }, { trait_type: "Age", value: 5 }] })
    )}`;

    const rawUri = `data:application/json,{"name":"Lifeform 1","attributes":[{"trait_type":"Kind","value":"Loop"},{"trait_type":"Age","value":5}]}`;
    const decodedPercent = await fetchJson(uri);
    const decodedRaw = await fetchJson(rawUri);
    const expected = { name: "Lifeform 1", attributes: [{ trait_type: "Kind", value: "Loop" }, { trait_type: "Age", value: 5 }] };
    expect(decodedPercent).toEqual(expected);
    expect(decodedRaw).toEqual(expected);
  });

  test("returns null for a malformed data URI", async () => {
    expect(await fetchJson("data:application/json,")).toBeNull();
  });
});

describe("fetchJson redirect handling", () => {
  test("follows a single redirect to a public https URL", async () => {
    const restore = mockFetchOnce({
      "https://1.1.1.1/a": new Response(null, {
        status: 301,
        headers: { Location: "https://1.1.1.1/b" },
      }),
      "https://1.1.1.1/b": Response.json({ name: "Redirected" }),
    });
    try {
      const result = await fetchJson("https://1.1.1.1/a");
      expect(result).toEqual({ name: "Redirected" });
    } finally {
      restore();
    }
  });

  test("does not follow a redirect to a private/internal address", async () => {
    const restore = mockFetchOnce({
      "https://1.1.1.1/a": new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:9/internal" },
      }),
    });
    try {
      const result = await fetchJson("https://1.1.1.1/a");
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  test("does not follow a second hop of redirects", async () => {
    const restore = mockFetchOnce({
      "https://1.1.1.1/a": new Response(null, {
        status: 301,
        headers: { Location: "https://1.1.1.1/b" },
      }),
      "https://1.1.1.1/b": new Response(null, {
        status: 301,
        headers: { Location: "https://1.1.1.1/c" },
      }),
    });
    try {
      const result = await fetchJson("https://1.1.1.1/a");
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });
});
