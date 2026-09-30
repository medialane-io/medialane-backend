import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { provisioningKeyWith } from "../../utils/provisioningKey.js";
import { createBusinessProvisioningRoutes, type BusinessProvisioningDeps, type ProvisioningRecord } from "./business-provisioning.js";

const SECRET = "c".repeat(64);

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

function fakeDeps(overrides: Partial<BusinessProvisioningDeps> = {}) {
  const store = new Map<string, ProvisioningRecord & { derivationSalt: string | null }>();
  const deployed: { ownerAddress: string; signature: string[] }[] = [];
  const signedWith: string[] = [];
  let seq = 0;
  const deps: BusinessProvisioningDeps = {
    keyFor: (input) => provisioningKeyWith(SECRET, input),
    newSalt: () => "0123456789abcdef",
    buildDeployment: async (owner) => ({ typedData: { owner }, deployment: { address: owner.ownerAddress } }),
    signTypedData: (privateKey) => {
      signedWith.push(privateKey);
      return ["0xr", "0xs"];
    },
    deployWallet: async (input) => {
      deployed.push({ ownerAddress: input.ownerAddress, signature: input.signature });
      return "0xdeploytx";
    },
    findExistingWalletForRecipient: async () => null,
    ensureRecipientAccount: async (_clientId, _scheme, value) => `acct-for-${value}`,
    linkWalletToAccount: async () => {},
    createProvisioning: async (input) => {
      seq += 1;
      const record = { id: `prov-${seq}`, status: "DEPLOYED" as const, newOwnerPubkey: null, ...input };
      store.set(record.id, record);
      return record;
    },
    listProvisioning: async (apiClientId) => [...store.values()].filter((r) => r.apiClientId === apiClientId),
    getProvisioningById: async (id, apiClientId) => {
      const r = store.get(id);
      return r && r.apiClientId === apiClientId ? r : null;
    },
    ...overrides,
  };
  return { deps, store, deployed, signedWith };
}

const issue = (app: Hono<AppEnv>, recipientValue: string) =>
  app.request("/v1/business/provisioning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain: "STARKNET", recipientScheme: "email", recipientValue }),
  });

describe("POST /v1/business/provisioning", () => {
  test("deploys a wallet owned by the key the backend computes", async () => {
    const { deps, deployed, store } = fakeDeps();
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(201);
    const key = provisioningKeyWith(SECRET, { apiClientId: "biz-1", recipientScheme: "email", recipientValue: "ana@example.com", salt: "0123456789abcdef" });
    const [record] = [...store.values()];
    expect(deployed).toHaveLength(1);
    expect(BigInt(record!.walletAddress)).toBe(BigInt(key.walletAddress));
    expect(BigInt(record!.interimOwnerPubkey!)).toBe(BigInt(key.publicKey));
    expect(record!.derivationSalt).toBe("0123456789abcdef");
  });

  test("stores no private key", async () => {
    const { deps, store, signedWith } = fakeDeps();
    await issue(makeApp(deps), "ana@example.com");
    const stored = JSON.stringify([...store.values()]);
    expect(signedWith).toHaveLength(1);
    expect(stored.includes(signedWith[0]!.replace(/^0x/, ""))).toBe(false);
  });

  test("stores the recipient normalized, so a different letter case still matches later", async () => {
    const { deps, store } = fakeDeps();
    await issue(makeApp(deps), "Ana@Example.com");
    expect([...store.values()][0]!.recipientValue).toBe("ana@example.com");
  });

  test("ignores a signed deployment sent by an old client", async () => {
    const { deps, deployed } = fakeDeps();
    const res = await makeApp(deps).request("/v1/business/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "STARKNET",
        recipientScheme: "email",
        recipientValue: "ana@example.com",
        interimOwnerPubkey: "0x1",
        derivationSalt: "s".repeat(16),
        deployment: { typedData: {}, signature: ["0x1"], deployment: {} },
      }),
    });
    expect(res.status).toBe(201);
    expect(deployed[0]!.signature).toEqual(["0xr", "0xs"]);
  });

  test("puts the assets in the wallet the recipient already has", async () => {
    const { deps, deployed, store } = fakeDeps({
      findExistingWalletForRecipient: async () => ({ accountId: "acct-ana", walletAddress: "0xabc" }),
    });
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(200);
    expect(deployed).toHaveLength(0);
    const [record] = [...store.values()];
    expect(record!.status).toBe("REUSED");
    expect(record!.interimOwnerPubkey).toBeNull();
    expect(record!.derivationSalt).toBeNull();
  });

  test("records nothing when the deploy fails", async () => {
    const { deps, store } = fakeDeps({
      deployWallet: async () => {
        throw new Error("paymaster down");
      },
    });
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(502);
    expect(store.size).toBe(0);
  });
});

describe("recipients belong to the business's client", () => {
  test("a new recipient's account and wallet are created under the business's client", async () => {
    const seen: string[] = [];
    const { deps } = fakeDeps({
      ensureRecipientAccount: async (clientId) => {
        seen.push(`account:${clientId}`);
        return "acct-ana";
      },
      linkWalletToAccount: async ({ clientId }) => {
        seen.push(`link:${clientId}`);
      },
    });
    await issue(makeApp(deps, "biz-7"), "ana@example.com");
    expect(seen).toEqual(["account:biz-7", "link:biz-7"]);
  });
});

describe("GET /v1/business/provisioning", () => {
  test("lists only the caller's own rows", async () => {
    const { deps } = fakeDeps();
    await issue(makeApp(deps, "biz-1"), "ana@example.com");
    await issue(makeApp(deps, "biz-2"), "bob@example.com");
    const res = await makeApp(deps, "biz-1").request("/v1/business/provisioning");
    const body = (await res.json()) as { data: ProvisioningRecord[] };
    expect(body.data.map((r) => r.recipientValue)).toEqual(["ana@example.com"]);
  });
});

describe("the business-signed handoff is gone", () => {
  test.each([
    ["POST", "/v1/business/provisioning/handoff"],
    ["GET", "/v1/business/provisioning/prov-1/handoff-calls"],
    ["POST", "/v1/business/provisioning/prov-1/complete"],
  ])("%s %s is 404", async (method, path) => {
    const { deps } = fakeDeps();
    expect((await makeApp(deps).request(path, { method })).status).toBe(404);
  });
});
