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
    findAccountWallet: async () => null,
    getProvisioningByWallet: async (_chain, walletAddress) =>
      [...store.values()].find((r) => r.walletAddress === walletAddress) ?? null,
    deployWallet: async () => "0xdeploytx",
    ensureRecipientAccount: async (_scheme, value) => `acct-for-${value}`,
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

  test("creates an account for a recipient identified by something other than email", async () => {
    const linked: string[] = [];
    const deps = fakeDeps({ linkWalletToAccount: async ({ accountId }) => { linked.push(accountId); } });
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
    expect(linked).toEqual(["acct-for-12345"]);
  });

  test("creates the account before deploying the wallet", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      ensureRecipientAccount: async () => { order.push("account"); return "acct-1"; },
      deployWallet: async () => { order.push("deploy"); return "0xtx"; },
      linkWalletToAccount: async () => { order.push("link"); },
    });
    const app = makeApp(deps);

    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "student@example.com",
        interimOwnerPubkey: "0x2",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });

    expect(res.status).toBe(201);
    expect(order).toEqual(["account", "deploy", "link"]);
  });

  test("reuses the wallet an account already has instead of deploying another", async () => {
    let deploys = 0;
    const deps = fakeDeps({
      findAccountWallet: async () => "0xexisting",
      deployWallet: async () => { deploys += 1; return "0xtx"; },
    });
    const app = makeApp(deps);

    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "already@example.com",
        interimOwnerPubkey: "0x2",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });

    expect(res.status).toBe(200);
    expect(deploys).toBe(0);
    const body = (await res.json()) as { data: ProvisioningRecord; reusedExistingWallet: boolean };
    expect(body.reusedExistingWallet).toBe(true);
    expect(body.data.walletAddress).toBe("0xexisting");
  });

  test("deploys a wallet for an account that exists but has none", async () => {
    let deploys = 0;
    const deps = fakeDeps({
      findAccountWallet: async () => null,
      deployWallet: async () => { deploys += 1; return "0xtx"; },
    });
    const app = makeApp(deps);

    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "nowallet@example.com",
        interimOwnerPubkey: "0x2",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });

    expect(res.status).toBe(201);
    expect(deploys).toBe(1);
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

describe("POST /v1/business/provisioning/handoff", () => {
  async function register(app: ReturnType<typeof makeApp>) {
    return app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "student@example.com",
        interimOwnerPubkey: "0x222",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });
  }

  test("records the recipient's key and the proof it can sign", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    await register(app);

    const res = await app.request("/v1/business/provisioning/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: "0x111",
        newOwnerPubkey: "0xabc",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ProvisioningRecord };
    expect(body.data.status).toBe("HANDOFF");
    expect(BigInt(body.data.newOwnerPubkey!)).toBe(BigInt("0xabc"));
  });

  test("refuses a handoff without a recipient key", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);
    await register(app);

    const res = await app.request("/v1/business/provisioning/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: "0x111" }),
    });

    expect(res.status).toBe(400);
  });

  test("404s for a wallet that was never provisioned", async () => {
    const app = makeApp(fakeDeps());
    const res = await app.request("/v1/business/provisioning/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: "0x999",
        newOwnerPubkey: "0xabc",
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/business/provisioning/:id/handoff-calls", () => {
  test("returns one call adding the recipient and one removing the business", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);

    const created = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "someone@example.com",
        interimOwnerPubkey: "0x222",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });
    const { data: record } = (await created.json()) as { data: ProvisioningRecord };

    await app.request("/v1/business/provisioning/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: "0x111", newOwnerPubkey: "0xabc" }),
    });

    const res = await app.request(`/v1/business/provisioning/${record.id}/handoff-calls`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { addRecipient: { entrypoint: string }; removeInterim: { entrypoint: string } };
    };
    expect(body.data.addRecipient.entrypoint).toBe("change_owners");
    expect(body.data.removeInterim.entrypoint).toBe("change_owners");
  });

  test("409s before the recipient has supplied a key", async () => {
    const deps = fakeDeps();
    const app = makeApp(deps);

    const created = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientScheme: "email",
        recipientValue: "someone@example.com",
        interimOwnerPubkey: "0x222",
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });
    const { data: record } = (await created.json()) as { data: ProvisioningRecord };

    const res = await app.request(`/v1/business/provisioning/${record.id}/handoff-calls`);
    expect(res.status).toBe(409);
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
