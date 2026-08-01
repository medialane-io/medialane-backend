import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createBusinessProvisioningRoutes, type BusinessProvisioningDeps, type ProvisioningRecord } from "./business-provisioning.js";

function makeApp(deps: BusinessProvisioningDeps, accountId = "biz-1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: accountId, plan: "FREE", status: "ACTIVE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/business/provisioning", createBusinessProvisioningRoutes(deps));
  return app;
}

function fakeDeps(overrides: Partial<BusinessProvisioningDeps> = {}): BusinessProvisioningDeps {
  const store = new Map<string, ProvisioningRecord>();
  let seq = 0;
  return {
    isAccountOwner: async () => true,
    createProvisioning: async (input) => {
      seq += 1;
      const record: ProvisioningRecord = { id: `prov-${seq}`, status: "PROVISIONED", newOwnerPubkey: null, ...input };
      store.set(record.id, record);
      return record;
    },
    listProvisioning: async (accountId) => [...store.values()].filter((r) => r.accountId === accountId),
    getProvisioningById: async (id, accountId) => {
      const r = store.get(id);
      return r && r.accountId === accountId ? r : null;
    },
    markClaimed: async (id) => {
      const r = store.get(id)!;
      const updated = { ...r, status: "CLAIMED" as const };
      store.set(id, updated);
      return updated;
    },
    recordNewOwnerPubkey: async (id, pubkey) => {
      const r = store.get(id)!;
      const updated = { ...r, newOwnerPubkey: pubkey, status: "CLAIM_PENDING" as const };
      store.set(id, updated);
      return updated;
    },
    createClaimToken: async () => ({ token: "tok_1", expiresAt: new Date(Date.now() + 86_400_000) }),
    sendClaimEmail: async () => {},
    ...overrides,
  };
}

describe("POST /v1/business/provisioning", () => {
  test("registers a provisioned wallet after verifying the interim owner on-chain", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        walletAddress: "0x111",
        recipientEmail: "worker@example.com",
        interimOwnerPubkey: "0x222",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: ProvisioningRecord };
    expect(body.data.status).toBe("PROVISIONED");
    expect(body.data.accountId).toBe("biz-1");
  });

  test("rejects when the interim key is not actually the on-chain owner", async () => {
    const deps = fakeDeps({ isAccountOwner: async () => false });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        walletAddress: "0x111",
        recipientEmail: "worker@example.com",
        interimOwnerPubkey: "0x222",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("interim_owner_mismatch");
  });
});

describe("GET /v1/business/provisioning", () => {
  test("lists only the caller's own rows", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    await deps.createProvisioning({ accountId: "biz-1", chain: "STARKNET", walletAddress: "0xA", recipientEmail: "a@example.com", interimOwnerPubkey: "0x1" });
    await deps.createProvisioning({ accountId: "biz-2", chain: "STARKNET", walletAddress: "0xB", recipientEmail: "b@example.com", interimOwnerPubkey: "0x2" });
    const res = await app.request("/v1/business/provisioning");
    const body = (await res.json()) as { data: ProvisioningRecord[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].walletAddress).toBe("0xA");
  });
});
