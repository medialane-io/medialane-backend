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

test("POST /wallet/deploy recovers gracefully when deploy fails because the contract is already deployed", async () => {
  // Reproduced live: isDeployed() said false (a moments-old deploy from a
  // retried attempt hadn't propagated to this RPC view yet), so deploy was
  // attempted anyway and the network rejected it with exactly this message
  // — the wallet is genuinely fine, this must not surface as a failure.
  const deps: WalletRouteDeps = {
    computeAddress: () => "0xcomputed",
    isDeployed: async () => false,
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
