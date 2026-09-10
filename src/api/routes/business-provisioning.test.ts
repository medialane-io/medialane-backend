import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createBusinessProvisioningRoutes, type BusinessProvisioningDeps, type ProvisioningRecord } from "./business-provisioning.js";

function makeApp(deps: BusinessProvisioningDeps, apiClientId = "biz-1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: `acc-${apiClientId}`, status: "ACTIVE" });
    c.set("apiClient", { id: apiClientId, accountId: `acc-${apiClientId}`, plan: "FREE", creditBalance: 0 });
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
    deriveWalletAddress: () => "0x111",
    deployWallet: async () => "0xdeploytx",
    ensureRecipientAccount: async (scheme, value) => (scheme === "email" ? `acct-for-${value}` : null),
    linkWalletToAccount: async () => {},
    createProvisioning: async (input) => {
      seq += 1;
      const record: ProvisioningRecord = { id: `prov-${seq}`, status: "DEPLOYED", newOwnerPubkey: null, ...input };
      store.set(record.id, record);
      return record;
    },
    listProvisioning: async (apiClientId) => [...store.values()].filter((r) => r.apiClientId === apiClientId),
    getProvisioningById: async (id, apiClientId) => {
      const r = store.get(id);
      return r && r.apiClientId === apiClientId ? r : null;
    },
    getProvisioningByIdUnscoped: async () => null,
    markTransferred: async (id) => {
      const r = store.get(id)!;
      const updated = { ...r, status: "TRANSFERRED" as const };
      store.set(id, updated);
      return updated;
    },
    recordNewOwnerPubkey: async (id, pubkey) => {
      const r = store.get(id)!;
      const updated = { ...r, newOwnerPubkey: pubkey, status: "HANDOFF" as const };
      store.set(id, updated);
      return updated;
    },
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
        recipientScheme: "email", recipientValue: "worker@example.com",
        interimOwnerPubkey: "0x222",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: ProvisioningRecord };
    expect(body.data.status).toBe("DEPLOYED");
    expect(body.data.apiClientId).toBe("biz-1");
  });

  test("creates an account for the recipient and links the wallet to it", async () => {
    let linked: { walletAddress: string; accountId: string } | null = null;
    const deps = fakeDeps({
      linkWalletToAccount: async ({ walletAddress, accountId }) => {
        linked = { walletAddress, accountId };
      },
    });
    const app = makeApp(deps);

    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "student@example.com",
        interimOwnerPubkey: "0x2",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });

    expect(res.status).toBe(201);
    expect(linked).not.toBeNull();
    expect(linked!.accountId).toBe("acct-for-student@example.com");
  });

  test("registers without an account when the recipient is not identified by email", async () => {
    let linkCalls = 0;
    const deps = fakeDeps({ linkWalletToAccount: async () => { linkCalls += 1; } });
    const app = makeApp(deps);

    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "student_id",
        recipientValue: "12345",
        interimOwnerPubkey: "0x2",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });

    expect(res.status).toBe(201);
    expect(linkCalls).toBe(0);
  });

  test("records nothing when the wallet fails to deploy", async () => {
    let created = 0;
    const deps = fakeDeps({
      deployWallet: async () => { throw new Error("paymaster rejected the deployment"); },
      linkWalletToAccount: async () => { created += 1; },
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        recipientScheme: "email", recipientValue: "worker@example.com",
        interimOwnerPubkey: "0x222",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_failed");
    expect(created).toBe(0);
  });
});

describe("GET /v1/business/provisioning", () => {
  test("lists only the caller's own rows", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    await deps.createProvisioning({ apiClientId: "biz-1", accountId: "acc-biz-1", chain: "STARKNET", walletAddress: "0xA", recipientScheme: "email", recipientValue: "a@example.com", interimOwnerPubkey: "0x1" });
    await deps.createProvisioning({ apiClientId: "biz-2", accountId: "acc-biz-2", chain: "STARKNET", walletAddress: "0xB", recipientScheme: "email", recipientValue: "b@example.com", interimOwnerPubkey: "0x2" });
    const res = await app.request("/v1/business/provisioning");
    const body = (await res.json()) as { data: ProvisioningRecord[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].walletAddress).toBe("0xA");
  });
});

describe("POST /v1/business/provisioning/:id/complete", () => {
  const claimPendingRecord: ProvisioningRecord = {
    id: "prov-1", apiClientId: "biz-1", chain: "STARKNET", walletAddress: "0xa",
    recipientScheme: "email", recipientValue: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: "0x3", status: "HANDOFF",
  };

  test("marks TRANSFERRED once the new owner is confirmed on-chain and the interim owner is gone", async () => {
    const deps = fakeDeps({
      getProvisioningById: async (id, apiClientId) => (id === "prov-1" && apiClientId === "biz-1" ? claimPendingRecord : null),
      isAccountOwner: async (_chain, _wallet, pubkey) => pubkey === "0x3",
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/prov-1/complete", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ProvisioningRecord };
    expect(body.data.status).toBe("TRANSFERRED");
  });

  test("409s when the on-chain handoff isn't confirmed yet", async () => {
    const deps = fakeDeps({
      getProvisioningById: async () => claimPendingRecord,
      isAccountOwner: async () => false,
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/prov-1/complete", { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("404s for a row that belongs to a different business account", async () => {
    const deps = fakeDeps({ getProvisioningById: async () => null });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/prov-1/complete", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
