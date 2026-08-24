import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hash, num } from "starknet";
import { getCoordinates } from "@medialane/sdk";
import paymaster, { type PaymasterClient } from "./paymaster.js";
import type { AppEnv } from "../../types/hono.js";

const SPONSORABLE_CALL = { contractAddress: "0x1", entrypoint: "approve", calldata: ["0x2", "0x3"] };

function outsideCall(c: typeof SPONSORABLE_CALL) {
  return {
    To: c.contractAddress,
    Selector: num.toHex(hash.getSelectorFromName(c.entrypoint)),
    Calldata: c.calldata,
  };
}

// One OutsideCallV2 per submitted call plus a trailing extra — the shape
// AVNU's "default" (non-sponsored) fee mode uses, with a fee-payment call
// appended after the caller's own calls.
function outsideExecutionTypedData(calls: typeof SPONSORABLE_CALL[]) {
  return {
    message: {
      Calls: [...calls.map(outsideCall), { To: "0x0", Selector: "0x0", Calldata: [] }],
    },
  };
}

// Exactly one OutsideCallV2 per submitted call, no trailing extra — the real
// shape AVNU's "sponsored" fee mode uses (no fee call needed when Medialane
// pays gas). Regression coverage for the 2026-08-24 incident: the old check
// (borrowed from starknet.js's own assertCallsAreStrictlyEqual) assumed a
// trailing call always exists and rejected every real sponsored listing.
function sponsoredOutsideExecutionTypedData(calls: typeof SPONSORABLE_CALL[]) {
  return { message: { Calls: calls.map(outsideCall) } };
}

function appWith(client: Partial<PaymasterClient>, calls: unknown[] = []) {
  const stub: PaymasterClient = {
    buildTransaction: async (req, opts) => {
      calls.push({ fn: "build", req, opts });
      return { typed_data: { message: "td" }, deployment: { address: "0xdep" } } as never;
    },
    executeTransaction: async (req, opts) => {
      calls.push({ fn: "execute", req, opts });
      return { transaction_hash: "0xtx" } as never;
    },
    ...client,
  };
  const app = new Hono<AppEnv>();
  app.route("/", paymaster(() => stub));
  return app;
}

describe("POST /invoke/build", () => {
  test("builds a sponsored invoke and returns only the typed data", async () => {
    const calls: unknown[] = [];
    const res = await appWith({}, calls).request("/invoke/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", calls: [SPONSORABLE_CALL] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ typedData: { message: "td" } });
    const built = calls[0] as { req: { type: string }; opts: { feeMode: { mode: string } } };
    expect(built.req.type).toBe("invoke");
    expect(built.opts.feeMode.mode).toBe("sponsored");
  });

  test("rejects a missing address or an empty call list without reaching the paymaster", async () => {
    const calls: unknown[] = [];
    for (const body of [{ calls: [{}] }, { userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", calls: [] }, {}]) {
      const res = await appWith({}, calls).request("/invoke/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(calls.length).toBe(0);
  });

  test("rejects an entrypoint outside the sponsorable set", async () => {
    const calls: unknown[] = [];
    const res = await appWith({}, calls).request("/invoke/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        calls: [{ contractAddress: "0x1", entrypoint: "upgrade", calldata: [] }],
      }),
    });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe("POST /invoke/execute", () => {
  test("executes and returns the transaction hash", async () => {
    const res = await appWith({}).request("/invoke/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        typedData: outsideExecutionTypedData([SPONSORABLE_CALL]),
        signature: ["0x1", "0x2"],
        calls: [SPONSORABLE_CALL],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transactionHash: "0xtx" });
  });

  test("requires the signature", async () => {
    const res = await appWith({}).request("/invoke/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", typedData: { m: 1 }, calls: [SPONSORABLE_CALL] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects an entrypoint outside the sponsorable set", async () => {
    const res = await appWith({}).request("/invoke/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        typedData: { m: 1 },
        signature: ["0x1"],
        calls: [{ contractAddress: "0x1", entrypoint: "upgrade", calldata: [] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects typedData whose calls don't match the submitted calls", async () => {
    const res = await appWith({}).request("/invoke/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",

        typedData: outsideExecutionTypedData([{ ...SPONSORABLE_CALL, contractAddress: "0x999" }]),
        signature: ["0x1"],
        calls: [SPONSORABLE_CALL],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts sponsored-mode typedData with no trailing fee call (multi-call listing)", async () => {
    const registerOrder = { contractAddress: "0x2", entrypoint: "register_order", calldata: ["0x4"] };
    const calls = [SPONSORABLE_CALL, registerOrder];
    const res = await appWith({}).request("/invoke/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        typedData: sponsoredOutsideExecutionTypedData(calls),
        signature: ["0x1"],
        calls,
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /deploy/build", () => {
  test("builds a deploy_and_invoke using the Media Wallet class hash", async () => {
    const calls: unknown[] = [];
    const res = await appWith({}, calls).request("/deploy/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPubkey: "0x02c1a3f0d5b7e9c8a4d6f2b1e3c5a7098d4f6b2e1c3a5079b8d6f4e2c1a30597", ownerAddress: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" }),
    });
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { typedData: unknown; deployment: unknown; calls: unknown[] };
    expect(responseBody.typedData).toEqual({ message: "td" });
    expect(responseBody.deployment).toEqual({ address: "0xdep" });
    expect(responseBody.calls.length).toBe(1);

    const built = calls[0] as {
      req: { type: string; deployment: { class_hash: string; salt: string; address: string }; invoke: { calls: unknown[] } };
    };
    expect(built.req.type).toBe("deploy_and_invoke");
    expect(built.req.deployment.address).toBe("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");
    expect(built.req.deployment.class_hash.startsWith("0x")).toBe(true);
    expect(built.req.deployment.salt).toBe("0x0");
    // The response's `calls` must be exactly what was sent to the paymaster —
    // it's what the client will echo back verbatim to /deploy/execute.
    expect(responseBody.calls).toEqual(built.req.invoke.calls);
  });

  test("honours an explicit salt", async () => {
    const calls: unknown[] = [];
    await appWith({}, calls).request("/deploy/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPubkey: "0x02c1a3f0d5b7e9c8a4d6f2b1e3c5a7098d4f6b2e1c3a5079b8d6f4e2c1a30597", ownerAddress: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", salt: "0x7" }),
    });
    const built = calls[0] as { req: { deployment: { salt: string } } };
    expect(built.req.deployment.salt).toBe("0x7");
  });

  test("requires both the owner pubkey and address", async () => {
    for (const body of [{ ownerAddress: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" }, { ownerPubkey: "0x02c1a3f0d5b7e9c8a4d6f2b1e3c5a7098d4f6b2e1c3a5079b8d6f4e2c1a30597" }]) {
      const res = await appWith({}).request("/deploy/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /deploy/execute", () => {
  const OWNER_ADDRESS = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

  test("executes a deploy_and_invoke and returns the transaction hash", async () => {
    const classHash = getCoordinates("STARKNET").mediaWalletClassHash!;
    const res = await appWith({}).request("/deploy/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerAddress: OWNER_ADDRESS,
        typedData: outsideExecutionTypedData([SPONSORABLE_CALL]),
        signature: ["0x1"],
        deployment: { address: OWNER_ADDRESS, class_hash: classHash },
        calls: [SPONSORABLE_CALL],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transactionHash: "0xtx" });
  });

  test("requires the deployment payload", async () => {
    const res = await appWith({}).request("/deploy/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerAddress: OWNER_ADDRESS, typedData: { m: 1 }, signature: ["0x1"], calls: [SPONSORABLE_CALL] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a deployment for a class hash other than Media Wallet's", async () => {
    const res = await appWith({}).request("/deploy/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerAddress: OWNER_ADDRESS,
        typedData: outsideExecutionTypedData([SPONSORABLE_CALL]),
        signature: ["0x1"],
        deployment: { address: OWNER_ADDRESS, class_hash: "0xnotmediawallet" },
        calls: [SPONSORABLE_CALL],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("upstream failures", () => {
  test("a paymaster error becomes a 502, not an unhandled throw", async () => {
    const app = appWith({
      buildTransaction: async () => {
        throw new Error("paymaster down");
      },
    });
    const res = await app.request("/invoke/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", calls: [SPONSORABLE_CALL] }),
    });
    expect(res.status).toBe(502);
  });
});
