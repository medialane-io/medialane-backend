import { describe, test, expect } from "bun:test";
import { createFailoverFetch, isTransientRpcError } from "./rpcFailover.js";

const answer = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", result, id: 1 });
const rpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: 1 });

describe("which responses move on to the next endpoint", () => {
  test("a node that refuses us over http is skipped, whatever it says", () => {
    for (const status of [401, 402, 403, 404, 410, 429, 500, 502, 503]) {
      expect(`${status}:${isTransientRpcError({ status, body: "{}" })}`).toBe(`${status}:true`);
    }
    expect(isTransientRpcError({ status: 403, body: rpcError(-32600, "Cross-origin requests are not allowed") })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: rpcError(-32005, "Too many requests") })).toBe(true);
  });

  test("a body that is not a json-rpc answer is skipped", () => {
    expect(isTransientRpcError({ status: 200, body: "" })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: "<html>Bad gateway</html>" })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: "{}" })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: JSON.stringify({ message: "unauthorized" }) })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: JSON.stringify({ error: "unauthorized" }) })).toBe(true);
  });

  test("a provider fault is skipped", () => {
    expect(isTransientRpcError({ status: 200, body: rpcError(-32603, "internal") })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: rpcError(-32001, "rate limit") })).toBe(true);
    expect(isTransientRpcError({ status: 200, body: rpcError(429, "capacity") })).toBe(true);
  });

  test("a batch with one unusable answer is skipped", () => {
    const batch = `[${answer("0x1")},${rpcError(-32603, "internal")}]`;
    expect(isTransientRpcError({ status: 200, body: batch })).toBe(true);
  });

  test("a real answer stays, including a contract's own refusal", () => {
    expect(isTransientRpcError({ status: 200, body: answer(["0x1"]) })).toBe(false);
    expect(isTransientRpcError({ status: 200, body: answer(null) })).toBe(false);
    expect(isTransientRpcError({ status: 200, body: rpcError(21, "Invalid message selector") })).toBe(false);
    expect(isTransientRpcError({ status: 200, body: rpcError(40, "Contract error") })).toBe(false);
    expect(isTransientRpcError({ status: 200, body: `[${answer("0x1")},${rpcError(40, "Contract error")}]` })).toBe(false);
  });
});

describe("calling the endpoints in order", () => {
  const stub = (replies: Record<string, () => Response | Promise<Response>>, calls: string[]) =>
    (async (url: string) => {
      calls.push(url);
      return replies[url]!();
    }) as unknown as typeof fetch;

  const call = (urls: string[], fetchImpl: typeof fetch) =>
    createFailoverFetch(urls, { baseFetch: fetchImpl })("ignored", { method: "POST", body: "{}" }).then((res) => res.text());

  test("the fallback answers when the primary rejects our key", async () => {
    const calls: string[] = [];
    const text = await call(
      ["https://primary", "https://fallback"],
      stub({ "https://primary": () => new Response(rpcError(-32600, "invalid key"), { status: 401 }), "https://fallback": () => new Response(answer("0x7")) }, calls),
    );
    expect(text).toBe(answer("0x7"));
    expect(calls).toEqual(["https://primary", "https://fallback"]);
  });

  test("the fallback answers when the primary replies 200 with something that is not an answer", async () => {
    const calls: string[] = [];
    const text = await call(
      ["https://primary", "https://fallback"],
      stub({ "https://primary": () => new Response("{}"), "https://fallback": () => new Response(answer("0x7")) }, calls),
    );
    expect(text).toBe(answer("0x7"));
  });

  test("the fallback answers when the primary cannot be reached", async () => {
    const calls: string[] = [];
    const text = await call(
      ["https://primary", "https://fallback"],
      stub({ "https://primary": () => { throw new Error("connect failed"); }, "https://fallback": () => new Response(answer("0x7")) }, calls),
    );
    expect(text).toBe(answer("0x7"));
  });

  test("a good primary answer never touches the fallback", async () => {
    const calls: string[] = [];
    await call(["https://primary", "https://fallback"], stub({ "https://primary": () => new Response(answer("0x1")), "https://fallback": () => new Response(answer("0x2")) }, calls));
    expect(calls).toEqual(["https://primary"]);
  });

  test("a contract refusal from the primary is the answer", async () => {
    const calls: string[] = [];
    const text = await call(["https://primary", "https://fallback"], stub({ "https://primary": () => new Response(rpcError(40, "Contract error")), "https://fallback": () => new Response(answer("0x2")) }, calls));
    expect(text).toBe(rpcError(40, "Contract error"));
    expect(calls).toEqual(["https://primary"]);
  });

  test("when every endpoint fails the last response is returned", async () => {
    const calls: string[] = [];
    const text = await call(
      ["https://primary", "https://fallback"],
      stub({ "https://primary": () => new Response("down", { status: 503 }), "https://fallback": () => new Response("also down", { status: 502 }) }, calls),
    );
    expect(text).toBe("also down");
    expect(calls).toEqual(["https://primary", "https://fallback"]);
  });
});

describe("an endpoint that just failed is not tried again straight away", () => {
  const setup = () => {
    const calls: string[] = [];
    let clock = 0;
    const health = { primary: false };
    const baseFetch = (async (url: string) => {
      calls.push(url);
      if (url === "https://primary") {
        if (!health.primary) return new Response("down", { status: 503 });
        return new Response(answer("0x1"));
      }
      return new Response(answer("0x2"));
    }) as unknown as typeof fetch;
    const fetchImpl = createFailoverFetch(["https://primary", "https://fallback"], { baseFetch, cooldownMs: 30_000, now: () => clock });
    const call = () => fetchImpl("ignored", { method: "POST", body: "{}" }).then((res) => res.text());
    return { calls, health, call, advance: (ms: number) => { clock += ms; } };
  };

  test("the next calls go straight to the fallback while the primary cools down", async () => {
    const { calls, call } = setup();
    await call();
    await call();
    await call();
    expect(calls).toEqual(["https://primary", "https://fallback", "https://fallback", "https://fallback"]);
  });

  test("the primary is tried again after the cooldown and takes over when it is back", async () => {
    const { calls, health, call, advance } = setup();
    await call();
    advance(30_000);
    health.primary = true;
    expect(await call()).toBe(answer("0x1"));
    expect(await call()).toBe(answer("0x1"));
    expect(calls).toEqual(["https://primary", "https://fallback", "https://primary", "https://primary"]);
  });

  test("the primary is tried again after the cooldown and sent back to cooling if it is still down", async () => {
    const { calls, call, advance } = setup();
    await call();
    advance(30_000);
    await call();
    await call();
    expect(calls).toEqual(["https://primary", "https://fallback", "https://primary", "https://fallback", "https://fallback"]);
  });

  test("when every endpoint is cooling down they are all tried in order again", async () => {
    const calls: string[] = [];
    const fetchImpl = createFailoverFetch(["https://primary", "https://fallback"], {
      baseFetch: (async (url: string) => { calls.push(url); return new Response("down", { status: 503 }); }) as unknown as typeof fetch,
      cooldownMs: 30_000,
      now: () => 0,
    });
    await fetchImpl("ignored", { method: "POST", body: "{}" });
    await fetchImpl("ignored", { method: "POST", body: "{}" });
    expect(calls).toEqual(["https://primary", "https://fallback", "https://primary", "https://fallback"]);
  });

  test("an endpoint that is cooling down is still tried when the others fail", async () => {
    const calls: string[] = [];
    let clock = 0;
    let primaryUp = false;
    const fetchImpl = createFailoverFetch(["https://primary", "https://fallback"], {
      baseFetch: (async (url: string) => {
        calls.push(url);
        if (url === "https://primary") return primaryUp ? new Response(answer("0x1")) : new Response("down", { status: 503 });
        return clock === 0 ? new Response(answer("0x2")) : new Response(rpcError(429, "rate limited"), { status: 429 });
      }) as unknown as typeof fetch,
      cooldownMs: 30_000,
      now: () => clock,
    });
    await fetchImpl("ignored", { method: "POST", body: "{}" });
    clock = 1;
    primaryUp = true;
    const text = await fetchImpl("ignored", { method: "POST", body: "{}" }).then((res) => res.text());
    expect(text).toBe(answer("0x1"));
    expect(calls).toEqual(["https://primary", "https://fallback", "https://fallback", "https://primary"]);
  });

  test("a contract refusal does not put an endpoint on cooldown", async () => {
    const calls: string[] = [];
    const fetchImpl = createFailoverFetch(["https://primary", "https://fallback"], {
      baseFetch: (async (url: string) => { calls.push(url); return new Response(rpcError(40, "Contract error")); }) as unknown as typeof fetch,
      cooldownMs: 30_000,
      now: () => 0,
    });
    await fetchImpl("ignored", { method: "POST", body: "{}" });
    await fetchImpl("ignored", { method: "POST", body: "{}" });
    expect(calls).toEqual(["https://primary", "https://primary"]);
  });
});
