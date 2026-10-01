import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { provisioningKeyWith } from "../../utils/provisioningKey.js";
import { createBusinessProvisioningRoutes, type BusinessProvisioningDeps } from "./business-provisioning.js";

const SECRET = "c".repeat(64);

function makeApp(deps: BusinessProvisioningDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "acc-biz", status: "ACTIVE" });
    c.set("apiClient", { id: "biz-1", accountId: "acc-biz", plan: "FREE", creditBalance: 0 });
    await next();
  });
  app.route("/v1/business/provisioning", createBusinessProvisioningRoutes(deps));
  return app;
}

function fakeDeps(overrides: Partial<BusinessProvisioningDeps> = {}) {
  const accounts = new Map<string, { accountId: string; walletAddress: string | null }>();
  const deployed: string[] = [];
  const linked: { walletAddress: string; accountId: string }[] = [];
  const deps: BusinessProvisioningDeps = {
    findIoAccount: async (email) => accounts.get(email) ?? null,
    createIoAccount: async (email) => {
      const accountId = `acct-${email}`;
      accounts.set(email, { accountId, walletAddress: null });
      return accountId;
    },
    keyFor: (accountId) => provisioningKeyWith(SECRET, accountId),
    isDeployed: async (walletAddress) => deployed.includes(walletAddress),
    buildDeployment: async (owner) => ({ typedData: { owner }, deployment: { address: owner.ownerAddress } }),
    signTypedData: () => ["0xr", "0xs"],
    deployWallet: async (input) => {
      deployed.push(input.ownerAddress);
      return "0xdeploytx";
    },
    linkWallet: async ({ walletAddress, accountId }) => {
      linked.push({ walletAddress, accountId });
    },
    ...overrides,
  };
  return { deps, accounts, deployed, linked };
}

const issue = (app: Hono<AppEnv>, email: string) =>
  app.request("/v1/business/provisioning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain: "STARKNET", email }),
  });

describe("POST /v1/business/provisioning", () => {
  test("creates the account and deploys its wallet", async () => {
    const { deps, accounts, deployed, linked } = fakeDeps();
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(201);
    const key = provisioningKeyWith(SECRET, "acct-ana@example.com");
    const { data } = (await res.json()) as { data: { walletAddress: string } };
    expect(BigInt(data.walletAddress)).toBe(BigInt(key.walletAddress));
    expect(accounts.get("ana@example.com")?.accountId).toBe("acct-ana@example.com");
    expect(deployed).toHaveLength(1);
    expect(linked).toEqual([{ walletAddress: data.walletAddress, accountId: "acct-ana@example.com" }]);
  });

  test("reuses the wallet the account already has", async () => {
    const { deps, accounts, deployed } = fakeDeps();
    accounts.set("ana@example.com", { accountId: "acct-ana", walletAddress: "0xabc" });
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reusedExistingWallet: true });
    expect(deployed).toHaveLength(0);
  });

  test("deploys a wallet for an existing account without one", async () => {
    let created = 0;
    const { deps, accounts, linked } = fakeDeps({ createIoAccount: async () => `acct-${++created}` });
    accounts.set("ana@example.com", { accountId: "acct-ana", walletAddress: null });
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(201);
    expect(created).toBe(0);
    expect(linked[0]!.accountId).toBe("acct-ana");
  });

  test("finds the account whatever the letter case of the email", async () => {
    const asked: string[] = [];
    const { deps } = fakeDeps({
      findIoAccount: async (email) => {
        asked.push(email);
        return null;
      },
    });
    await issue(makeApp(deps), "Ana@Example.com");
    expect(asked).toEqual(["ana@example.com"]);
  });

  test("a retry after the deploy landed links the same wallet without deploying again", async () => {
    let failLink = true;
    const { deps, deployed, linked } = fakeDeps({
      linkWallet: async ({ walletAddress, accountId }) => {
        if (failLink) {
          failLink = false;
          throw new Error("db down");
        }
        linked.push({ walletAddress, accountId });
      },
    });
    const app = makeApp(deps);
    expect((await issue(app, "ana@example.com")).status).toBe(500);
    const res = await issue(app, "ana@example.com");
    expect(res.status).toBe(201);
    expect(deployed).toHaveLength(1);
    expect(linked).toHaveLength(1);
  });

  test("links nothing when the deploy fails", async () => {
    const { deps, linked } = fakeDeps({
      deployWallet: async () => {
        throw new Error("paymaster down");
      },
    });
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(502);
    expect(linked).toHaveLength(0);
  });

  test("a failed deployment check deploys nothing and links nothing", async () => {
    const { deps, deployed, linked } = fakeDeps({
      isDeployed: async () => {
        throw new Error("rpc unavailable");
      },
    });
    const res = await issue(makeApp(deps), "ana@example.com");
    expect(res.status).toBe(502);
    expect(deployed).toHaveLength(0);
    expect(linked).toHaveLength(0);
  });

  test("refuses anything that is not an email", async () => {
    const { deps } = fakeDeps();
    expect((await issue(makeApp(deps), "0xabc")).status).toBe(400);
    expect((await issue(makeApp(deps), "not-an-email")).status).toBe(400);
  });
});
