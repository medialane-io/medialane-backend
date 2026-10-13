import { describe, expect, test } from "bun:test";
import { fetchJson, retryDelayMs } from "./fetcher.js";

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

describe("fetchJson rate limiting", () => {
  function mockFetchSequence(responses: Response[]) {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      const res = responses[calls++];
      if (!res) throw new Error("Unexpected extra fetch");
      return res;
    }) as unknown as typeof fetch;
    return { restore: () => void (globalThis.fetch = original), calls: () => calls };
  }
  const limited = () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });

  test("waits and retries when the gateway answers 429", async () => {
    const mock = mockFetchSequence([limited(), new Response(JSON.stringify({ name: "A" }))]);
    try {
      expect(await fetchJson("https://1.1.1.1/rate-limited-once")).toEqual({ name: "A" });
      expect(mock.calls()).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("gives up after two retries so the next gateway can be tried", async () => {
    const mock = mockFetchSequence([limited(), limited(), limited()]);
    try {
      expect(await fetchJson("https://1.1.1.1/rate-limited")).toBeNull();
      expect(mock.calls()).toBe(3);
    } finally {
      mock.restore();
    }
  });

  test("does not retry other errors", async () => {
    const mock = mockFetchSequence([new Response("gone", { status: 404 })]);
    try {
      expect(await fetchJson("https://1.1.1.1/missing")).toBeNull();
      expect(mock.calls()).toBe(1);
    } finally {
      mock.restore();
    }
  });
});

describe("retryDelayMs", () => {
  const now = Date.parse("2026-10-13T00:00:00Z");
  test("reads Retry-After seconds or date, capped at 5 seconds", () => {
    expect(retryDelayMs("2", now)).toBe(2000);
    expect(retryDelayMs("0", now)).toBe(0);
    expect(retryDelayMs("120", now)).toBe(5000);
    expect(retryDelayMs("Tue, 13 Oct 2026 00:00:03 GMT", now)).toBe(3000);
  });

  test("waits one second when the header is missing or unreadable", () => {
    expect(retryDelayMs(null, now)).toBe(1000);
    expect(retryDelayMs("soon", now)).toBe(1000);
  });
});
