import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import rpc, { extractRpcMethod, isAllowedRpcBody } from "./rpc.js";
import type { AppEnv } from "../../types/hono.js";

describe("isAllowedRpcBody", () => {
  test("accepts an allowlisted method", () => {
    expect(isAllowedRpcBody({ jsonrpc: "2.0", method: "starknet_call", id: 1 })).toBe(true);
  });

  test("rejects a method that is not allowlisted", () => {
    expect(isAllowedRpcBody({ jsonrpc: "2.0", method: "starknet_dangerous", id: 1 })).toBe(false);
  });

  test("accepts a batch where every method is allowlisted", () => {
    expect(
      isAllowedRpcBody([
        { method: "starknet_call", id: 1 },
        { method: "starknet_getNonce", id: 2 },
      ]),
    ).toBe(true);
  });

  test("rejects a batch containing one disallowed method", () => {
    expect(
      isAllowedRpcBody([
        { method: "starknet_call", id: 1 },
        { method: "starknet_dangerous", id: 2 },
      ]),
    ).toBe(false);
  });

  test("rejects a body that carries no method", () => {
    expect(isAllowedRpcBody({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isAllowedRpcBody("not an object")).toBe(false);
    expect(isAllowedRpcBody(null)).toBe(false);
  });
});

describe("extractRpcMethod", () => {
  test("reads the method from a single call", () => {
    expect(extractRpcMethod({ method: "starknet_getNonce" })).toBe("starknet_getNonce");
  });

  test("labels a batch", () => {
    expect(extractRpcMethod([{ method: "starknet_call" }])).toBe("batch");
  });

  test("falls back to unknown", () => {
    expect(extractRpcMethod({})).toBe("unknown");
    expect(extractRpcMethod(null)).toBe("unknown");
  });
});

describe("POST /", () => {
  function appWith(fetchImpl: typeof fetch) {
    const app = new Hono<AppEnv>();
    app.route("/", rpc(fetchImpl));
    return app;
  }

  test("forwards an allowlisted call upstream and returns the response verbatim", async () => {
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: "0x1", id: 7 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await appWith(fetchImpl).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "starknet_call", params: [], id: 7 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", result: "0x1", id: 7 });
    expect(seenBody).toEqual({ jsonrpc: "2.0", method: "starknet_call", params: [], id: 7 });
  });

  test("refuses a method that is not allowlisted without calling upstream", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const res = await appWith(fetchImpl).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "starknet_dangerous", id: 1 }),
    });

    expect(called).toBe(false);
    const json = await res.json();
    expect(json.error.code).toBe(-32601);
  });

  test("rejects an unparseable body", async () => {
    const fetchImpl = (async () => new Response("{}")) as unknown as typeof fetch;
    const res = await appWith(fetchImpl).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const json = await res.json();
    expect(json.error.code).toBe(-32700);
  });

  test("reports an upstream failure as a JSON-RPC error rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("upstream unreachable");
    }) as unknown as typeof fetch;

    const res = await appWith(fetchImpl).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "starknet_call", id: 1 }),
    });

    const json = await res.json();
    expect(json.error.code).toBe(-32603);
  });

  test("never echoes the upstream URL into the error message", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED https://starknet-mainnet.g.alchemy.com/secret-key");
    }) as unknown as typeof fetch;

    const res = await appWith(fetchImpl).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "starknet_call", id: 1 }),
    });

    expect(JSON.stringify(await res.json())).not.toContain("secret-key");
  });
});
