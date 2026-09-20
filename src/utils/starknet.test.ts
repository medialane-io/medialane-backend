import { describe, expect, test } from "bun:test";
import { createFailoverFetch } from "@medialane/sdk";
import { normalizeAddress, normalizeHash, callRpc } from "./starknet.js";
import { rpcEndpoints } from "./rpcFetch.js";

describe("normalizeAddress", () => {
  test("pads a short address to 64 chars", () => {
    expect(normalizeAddress("STARKNET", "0x1")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  test("accepts and normalizes a fully-padded address", () => {
    const padded =
      "0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2";
    expect(normalizeAddress("STARKNET", padded)).toBe(padded);
  });

  test("lowercases uppercase hex", () => {
    expect(normalizeAddress("STARKNET", "0xABCD")).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000abcd",
    );
  });

  test("idempotent on already-normalized input", () => {
    const addr = normalizeAddress("STARKNET", "0xdead");
    expect(normalizeAddress("STARKNET", addr)).toBe(addr);
  });

  test("accepts decimal-string input (BigInt path)", () => {
    expect(normalizeAddress("STARKNET", "1")).toBe(normalizeAddress("STARKNET", "0x1"));
  });

  test("throws on non-hex input — guards against silent corruption", () => {
    expect(() => normalizeAddress("STARKNET", "banana")).toThrow("Invalid STARKNET address");
  });

});

describe("normalizeHash", () => {
  test("pads and lowercases like normalizeAddress", () => {

    expect(String(normalizeHash("0xABCD"))).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000abcd",
    );
  });

  test("throws on invalid hash", () => {
    expect(() => normalizeHash("not-a-hash")).toThrow("Invalid hash");
  });
});

describe("callRpc", () => {
  test("hands the caller the shared provider and returns its result", async () => {
    let calls = 0;
    const result = await callRpc(async () => {
      calls++;
      return "answered";
    });
    expect(result).toBe("answered");
    expect(calls).toBe(1);
  });

  test("an error from the node reaches the caller", async () => {
    await expect(
      callRpc(async () => {
        throw new Error("genuinely unreachable");
      }),
    ).rejects.toThrow("genuinely unreachable");
  });
});

describe("where a Starknet call goes", () => {
  test("a capped primary falls through to the next endpoint", async () => {
    const seen: string[] = [];
    const failover = createFailoverFetch(rpcEndpoints(), {
      baseFetch: (async (url: string) => {
        seen.push(String(url));
        return seen.length === 1
          ? new Response(JSON.stringify({ error: { code: 429, message: "Monthly capacity limit exceeded" } }), { status: 429 })
          : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const res = await failover(rpcEndpoints()[0]!, { method: "POST" });

    expect(res.status).toBe(200);
    expect(seen).toEqual(rpcEndpoints());
  });

  test("the endpoints are tried in order, primary first", () => {
    expect(rpcEndpoints()[0]).toBe(String(process.env.ALCHEMY_RPC_URL));
    expect(rpcEndpoints()).toHaveLength(2);
  });
});
