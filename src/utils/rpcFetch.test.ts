import { describe, expect, test } from "bun:test";
import { rpcEndpoints, redactRpcUrl, reportRpcEndpoints, timedFetch } from "./rpcFetch.js";

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

describe("what startup says about the rpc endpoints", () => {
  test("a dead endpoint is reported rather than discovered when it is needed", async () => {
    const results = await reportRpcEndpoints((async (url: string) =>
      String(url).includes("fallback")
        ? new Response("This endpoint has been discontinued.", { status: 410 })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch);

    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.status).toBe(410);
  });

  test("both answering is the healthy shape", async () => {
    const results = await reportRpcEndpoints((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    expect(results.every((r) => r.ok)).toBe(true);
  });
})

describe("an rpc call that stops mid-answer", () => {
  test("is cut off by the timeout instead of hanging the caller", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
            },
          }),
        ),
    });
    try {
      const outcome = await timedFetch(`http://127.0.0.1:${server.port}`, {}, 100)
        .then((res) => res.text())
        .then(() => "answered", () => "cut off");
      expect(outcome).toBe("cut off");
    } finally {
      server.stop(true);
    }
  }, 2000);
});
