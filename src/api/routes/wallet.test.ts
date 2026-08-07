import { test, expect } from "bun:test";
import { createWalletRoutes, type WalletRouteDeps } from "./wallet";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

function appWith(deps: WalletRouteDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", createWalletRoutes(deps));
  return app;
}

test("POST /wallet/deploy deploys a new wallet when not already deployed", async () => {
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => false,
    deploy: async () => ({ address: "0xcomputed", transactionHash: "0xtx" }),
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerPubkey: "0xowner" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.address).toBe("0xcomputed");
  expect(body.data.alreadyDeployed).toBe(false);
});

test("POST /wallet/deploy is idempotent — returns existing address without redeploying", async () => {
  let deployCalled = false;
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => true,
    deploy: async () => { deployCalled = true; return { address: "0xcomputed", transactionHash: "0xtx" }; },
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerPubkey: "0xowner" }),
  });
  const body = await res.json();
  expect(body.data.alreadyDeployed).toBe(true);
  expect(deployCalled).toBe(false);
});

test("POST /wallet/deploy recovers when deploy fails with 'already deployed' AND a re-check confirms it's genuinely there", async () => {
  // isDeployed() said false pre-deploy (a moments-old deploy from a
  // retried attempt hadn't propagated to this RPC view yet), deploy was
  // attempted anyway and the network rejected it with exactly this
  // message — but this time a RE-CHECK after the error confirms the
  // wallet really is live, so recovering as success is correct.
  let calls = 0;
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => {
      calls += 1;
      return calls > 1; // false pre-deploy, true on the post-error re-check
    },
    deploy: async () => {
      throw new Error(
        'Deployment failed: contract already deployed at address 0x0033c2d137ffa5f13de29ea56a03eb34b1f2aeda3490b88cbd4b15943b0d49af',
      );
    },
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerPubkey: "0xowner" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.address).toBe("0xcomputed");
  expect(body.data.alreadyDeployed).toBe(true);
});

test("POST /wallet/deploy retries the re-check with delay before giving up — recovers once propagation catches up", async () => {
  // Reproduced live 2026-08-07 (a second, distinct occurrence): the
  // wallet WAS genuinely deployed (confirmed independently against a
  // second RPC provider minutes later), but a single, immediate
  // re-check still hit the same propagation-lag RPC view that made the
  // original isDeployed() pre-check say false — needs the same
  // delay-based retry pattern as verifyStarknetWithRetry, not just one
  // extra check.
  let isDeployedCalls = 0;
  const sleeps: number[] = [];
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => {
      isDeployedCalls += 1;
      return isDeployedCalls > 3; // pre-deploy false, then false, false, true
    },
    deploy: async () => {
      throw new Error('Deployment failed: contract already deployed at address 0xcomputed');
    },
    sleep: async (ms) => { sleeps.push(ms); },
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerPubkey: "0xowner" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.alreadyDeployed).toBe(true);
  expect(sleeps.length).toBeGreaterThan(0);
});

test("POST /wallet/deploy surfaces a real failure when 'already deployed' is a false positive (re-check says not deployed)", async () => {
  // Reproduced live 2026-08-07: deployContract()'s fee-estimation step
  // against a flaky primary RPC provider threw "already deployed" for an
  // address that was never actually deployed — confirmed independently
  // against a second RPC provider, and by the relayer's own nonce not
  // having advanced (no transaction was ever really submitted). Blindly
  // trusting the error message here silently reports success for a
  // wallet that doesn't exist; a re-check must catch this.
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => false, // false both pre-deploy AND on every re-check retry
    deploy: async () => {
      throw new Error(
        'Deployment failed: contract already deployed at address 0xcomputed',
      );
    },
    sleep: async () => {},
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerPubkey: "0xowner" }),
  });
  expect(res.status).toBe(500);
});

test("POST /wallet/deploy still surfaces a genuine deploy failure (unrelated error)", async () => {
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => false,
    deploy: async () => { throw new Error("Relayer account has insufficient balance"); },
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerPubkey: "0xowner" }),
  });
  expect(res.status).toBe(500);
});

test("POST /wallet/deploy rejects a missing ownerPubkey", async () => {
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => false,
    deploy: async () => ({ address: "0xcomputed", transactionHash: "0xtx" }),
  };
  const res = await appWith(deps).request("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});
