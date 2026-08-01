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
      const record: ProvisioningRecord = { id: `prov-${seq}`, status: "DEPLOYED", newOwnerPubkey: null, ...input };
      store.set(record.id, record);
      return record;
    },
    listProvisioning: async (accountId) => [...store.values()].filter((r) => r.accountId === accountId),
    getProvisioningById: async (id, accountId) => {
      const r = store.get(id);
      return r && r.accountId === accountId ? r : null;
    },
    getProvisioningByIdUnscoped: async () => null,
    markClaimed: async (id) => {
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
    createClaimToken: async () => ({ token: "tok_1", expiresAt: new Date(Date.now() + 86_400_000) }),
    findClaimToken: async () => null,
    consumeClaimToken: async () => {},
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
        recipientScheme: "email", recipientValue: "worker@example.com",
        interimOwnerPubkey: "0x222",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: ProvisioningRecord & { claimUrl: string } };
    expect(body.data.status).toBe("DEPLOYED");
    expect(body.data.accountId).toBe("biz-1");
    expect(body.data.claimUrl).toContain("/claim/");
  });

  test("sends a claim email only for scheme \"email\" — other schemes still register and get claimUrl back", async () => {
    let emailed: { to: string; url: string } | undefined;
    const deps = fakeDeps({ sendClaimEmail: async (to, claimUrl) => { emailed = { to, url: claimUrl }; } });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        walletAddress: "0x111",
        recipientScheme: "phone",
        recipientValue: "+15550001111",
        interimOwnerPubkey: "0x222",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: ProvisioningRecord & { claimUrl: string } };
    expect(body.data.claimUrl).toContain("/claim/");
    expect(emailed).toBeUndefined();
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
        recipientScheme: "email", recipientValue: "worker@example.com",
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
    await deps.createProvisioning({ accountId: "biz-1", chain: "STARKNET", walletAddress: "0xA", recipientScheme: "email", recipientValue: "a@example.com", interimOwnerPubkey: "0x1" });
    await deps.createProvisioning({ accountId: "biz-2", chain: "STARKNET", walletAddress: "0xB", recipientScheme: "email", recipientValue: "b@example.com", interimOwnerPubkey: "0x2" });
    const res = await app.request("/v1/business/provisioning");
    const body = (await res.json()) as { data: ProvisioningRecord[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].walletAddress).toBe("0xA");
  });
});

describe("GET /v1/business/provisioning/claim/:token", () => {
  test("returns the wallet summary for a valid, unexpired token", async () => {
    const deps = fakeDeps({
      findClaimToken: async (token) =>
        token === "tok_1" ? { provisioningId: "prov-1", expiresAt: new Date(Date.now() + 1000), consumedAt: null } : null,
      getProvisioningByIdUnscoped: async (id) =>
        id === "prov-1"
          ? { id: "prov-1", accountId: "biz-1", chain: "STARKNET", walletAddress: "0xa", recipientScheme: "email", recipientValue: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: null, status: "DEPLOYED" }
          : null,
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { walletAddress: string } };
    expect(body.data.walletAddress).toBe("0xa");
  });

  test("404s for an unknown token", async () => {
    const app = makeApp(fakeDeps({ findClaimToken: async () => null }));
    const res = await app.request("/v1/business/provisioning/claim/nope");
    expect(res.status).toBe(404);
  });

  test("410s for an expired token", async () => {
    const deps = fakeDeps({
      findClaimToken: async () => ({ provisioningId: "prov-1", expiresAt: new Date(Date.now() - 1000), consumedAt: null }),
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1");
    expect(res.status).toBe(410);
  });
});

describe("POST /v1/business/provisioning/claim/:token", () => {
  test("records the recipient's new owner key and consumes the token", async () => {
    let consumed = "";
    let recorded: { id: string; pubkey: string } | undefined;
    const deps = fakeDeps({
      findClaimToken: async () => ({ provisioningId: "prov-1", expiresAt: new Date(Date.now() + 1000), consumedAt: null }),
      recordNewOwnerPubkey: async (id, pubkey) => {
        recorded = { id, pubkey };
        return { id, accountId: "biz-1", chain: "STARKNET", walletAddress: "0xa", recipientScheme: "email", recipientValue: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: pubkey, status: "HANDOFF" };
      },
      consumeClaimToken: async (token) => { consumed = token; },
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerPubkey: "0x3" }),
    });
    expect(res.status).toBe(200);
    expect(recorded?.id).toBe("prov-1");
    expect(consumed).toBe("tok_1");
  });

  test("rejects an already-consumed token", async () => {
    const deps = fakeDeps({
      findClaimToken: async () => ({ provisioningId: "prov-1", expiresAt: new Date(Date.now() + 1000), consumedAt: new Date() }),
    });
    const app = makeApp(deps);
    const res = await app.request("/v1/business/provisioning/claim/tok_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newOwnerPubkey: "0x3" }),
    });
    expect(res.status).toBe(410);
  });
});

describe("POST /v1/business/provisioning/:id/complete", () => {
  const claimPendingRecord: ProvisioningRecord = {
    id: "prov-1", accountId: "biz-1", chain: "STARKNET", walletAddress: "0xa",
    recipientScheme: "email", recipientValue: "a@example.com", interimOwnerPubkey: "0x1", newOwnerPubkey: "0x3", status: "HANDOFF",
  };

  test("marks TRANSFERRED once the new owner is confirmed on-chain and the interim owner is gone", async () => {
    const deps = fakeDeps({
      getProvisioningById: async (id, accountId) => (id === "prov-1" && accountId === "biz-1" ? claimPendingRecord : null),
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
