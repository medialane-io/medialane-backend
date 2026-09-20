import { describe, expect, test } from "bun:test";
import { rpcEndpoints, redactRpcUrl } from "./rpcFetch.js";

describe("which RPC endpoints the backend will call", () => {
  test("only keyed endpoints are used", () => {
    const endpoints = rpcEndpoints();
    expect(endpoints.length).toBeGreaterThan(0);
    for (const url of endpoints) {
      expect(url).not.toContain("lava.build");
    }
  });

  test("the primary comes first", () => {
    expect(rpcEndpoints()[0]).toBe(String(process.env.ALCHEMY_RPC_URL));
  });
});

describe("redacting an RPC url for logs", () => {
  test("a key anywhere in the path is dropped, whatever the url shape", () => {
    expect(redactRpcUrl("https://starknet.example.com/rpc/v0_9/SECRETKEY")).toBe("https://starknet.example.com");
    expect(redactRpcUrl("https://a.example.com/starknet/version/rpc/v0_9/SECRETKEY")).toBe("https://a.example.com");
    expect(redactRpcUrl("https://b.example.com/gateway/strk/rpc-http/SECRETKEY")).toBe("https://b.example.com");
  });

  test("the query string never survives either", () => {
    expect(redactRpcUrl("https://c.example.com/rpc?apikey=SECRETKEY")).toBe("https://c.example.com");
  });

  test("an unparseable url never leaks", () => {
    expect(redactRpcUrl("not a url")).toBe("invalid-rpc-url");
  });
});
