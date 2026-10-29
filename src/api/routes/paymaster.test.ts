import { describe, expect, test } from "bun:test";
import { billedCredits } from "../../payments/usage.js";
import { Hono } from "hono";
import { hash, num } from "starknet";
import { getCoordinates } from "@medialane/sdk";
import { ownerConstructorCalldata } from "@medialane/sdk/starknet";
import paymaster, { deploymentCalls, deploymentIsMediaWallet, type AttachWallet, type PaymasterClient } from "./paymaster.js";
import type { AppEnv } from "../../types/hono.js";
import type { SponsorIntentDeps, SponsorIntentRow } from "./sponsorIntents.js";
import type { Cosign } from "../../utils/guardianCosign.js";
import { WalletAlreadyAttachedError } from "../../utils/account.js";

const SPONSORABLE_CALL = { contractAddress: "0x1", entrypoint: "approve", calldata: ["0x2", "0x3"] };

function outsideCall(c: typeof SPONSORABLE_CALL) {
  return {
    To: c.contractAddress,
    Selector: num.toHex(hash.getSelectorFromName(c.entrypoint)),
    Calldata: c.calldata,
  };
}

function outsideExecutionTypedData(calls: typeof SPONSORABLE_CALL[]) {
  return {
    message: {
      Calls: [...calls.map(outsideCall), { To: "0x0", Selector: "0x0", Calldata: [] }],
    },
  };
}

function sponsoredOutsideExecutionTypedData(calls: typeof SPONSORABLE_CALL[]) {
  return { message: { Calls: calls.map(outsideCall) } };
}

function billing(app: Hono<AppEnv>) {
  const credits: Array<number | undefined> = [];
  const outer = new Hono<AppEnv>();
  outer.use("*", async (c, next) => {
    await next();
    credits.push(billedCredits(c));
  });
  outer.route("/", app);
  return { app: outer, credits };
}

function appWith(
  client: Partial<PaymasterClient>,
  calls: unknown[] = [],
  session: { accountId?: string; attached?: unknown[]; attach?: AttachWallet } = { accountId: "acct-1" },
) {
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
  const attach: AttachWallet = session.attach ?? (async (input) => { session.attached?.push(input); });
  const app = new Hono<AppEnv>();
  app.route("/", paymaster(() => stub, (c, next) => {
    if (session.accountId) c.set("sessionAccountId", session.accountId);
    return next();
  }, undefined, attach));
  return app;
}

describe("POST /invoke/build and /invoke/execute", () => {
  test("build returns only the typed data and asks AVNU for sponsored mode", async () => {
    const seen: unknown[] = [];
    const res = await intentApp([signedRow], { buildTransaction: async (req, opts) => { seen.push(opts); return { typed_data: { message: "td" } } as never; } }, [])
      .request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ typedData: { message: "td" } });
    expect((seen[0] as { feeMode: { mode: string } }).feeMode.mode).toBe("sponsored");
  });

  test("execute requires the signature", async () => {
    const res = await intentApp([signedRow], {}, []).request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]) }));
    expect(res.status).toBe(400);
  });

  test("execute accepts typed data with or without the trailing fee call", async () => {
    for (const typedData of [outsideExecutionTypedData([SPONSORABLE_CALL]), sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL])]) {
      const res = await intentApp([signedRow], {}, []).request("/invoke/execute", postJson({ intentIds: ["i1"], typedData, signature: ["0x1"] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ transactionHash: "0xtx" });
    }
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

const MEDIA_WALLET_CLASS = getCoordinates("STARKNET").mediaWalletClassHash!;
const OWNER_PUBKEY = "0x02c1a3f0d5b7e9c8a4d6f2b1e3c5a7098d4f6b2e1c3a5079b8d6f4e2c1a30597";
const OWNER_CALLDATA = ownerConstructorCalldata(OWNER_PUBKEY).map((v) => num.toHex(v));
const DERIVED_ADDRESS = hash.calculateContractAddressFromHash("0x0", MEDIA_WALLET_CLASS, OWNER_CALLDATA, 0);
const walletDeployment = (address = DERIVED_ADDRESS) => ({ address, class_hash: MEDIA_WALLET_CLASS, salt: "0x0", calldata: OWNER_CALLDATA, version: 1 });

describe("POST /deploy/execute", () => {
  const OWNER_ADDRESS = DERIVED_ADDRESS;

  test("executes a deploy_and_invoke and returns the transaction hash", async () => {
    const classHash = getCoordinates("STARKNET").mediaWalletClassHash!;
    const res = await appWith({}).request("/deploy/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerAddress: OWNER_ADDRESS,
        typedData: outsideExecutionTypedData(deploymentCalls(OWNER_ADDRESS)),
        signature: ["0x1"],
        deployment: { ...walletDeployment(), class_hash: classHash },
        calls: deploymentCalls(OWNER_ADDRESS),
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

  test("refuses a deployment of another class without calling AVNU", async () => {
    let executed = false;
    const app = appWith({ executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } });
    const res = await app.request("/deploy/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerAddress: OWNER_ADDRESS, typedData: outsideExecutionTypedData(deploymentCalls(OWNER_ADDRESS)), signature: ["0x1"], deployment: { ...walletDeployment(), class_hash: "0x123" } }),
    });
    expect(res.status).toBe(400);
    expect(executed).toBe(false);
  });

  const deployBody = () => JSON.stringify({
    ownerAddress: OWNER_ADDRESS,
    typedData: outsideExecutionTypedData(deploymentCalls(OWNER_ADDRESS)),
    signature: ["0x1"],
    deployment: walletDeployment(),
  });
  const post = { method: "POST", headers: { "Content-Type": "application/json" } };

  test("links the wallet to the signed-in account before AVNU creates it", async () => {
    const attached: unknown[] = [];
    let linkedWhenExecuted = -1;
    const app = appWith(
      { executeTransaction: async () => { linkedWhenExecuted = attached.length; return { transaction_hash: "0xtx" } as never; } },
      [],
      { accountId: "acct-1", attached },
    );
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(200);
    expect(attached).toEqual([{ accountId: "acct-1", appId: "MEDIALANE_API", chain: "STARKNET", address: OWNER_ADDRESS }]);
    expect(linkedWhenExecuted).toBe(1);
  });

  test("an account that already has a different wallet is refused, and nothing is sponsored", async () => {
    const sent: unknown[] = [];
    const app = appWith(
      { executeTransaction: async () => { sent.push("executed"); return { transaction_hash: "0xtx" } as never; } },
      [],
      { accountId: "acct-1", attach: async () => { throw new WalletAlreadyAttachedError(); } },
    );
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_set_up" });
    expect(sent).toEqual([]);
  });

  test("a wallet deploy that may have been sent keeps one credit", async () => {
    const { app, credits } = billing(appWith({ executeTransaction: async () => { throw new Error("socket hang up"); } }));
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(502);
    expect(credits).toEqual([1]);
  });

  test("a wallet deploy the sponsor refused to run names no credits", async () => {
    const { app, credits } = billing(appWith({ executeTransaction: async () => { throw new Error("TRANSACTION_EXECUTION_ERROR"); } }));
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(422);
    expect(credits).toEqual([undefined]);
  });

  test("refuses without calling AVNU when the wallet cannot be linked", async () => {
    let executed = false;
    const app = appWith(
      { executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } },
      [],
      { accountId: "acct-1", attach: async () => { throw new Error("db down"); } },
    );
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(500);
    expect(executed).toBe(false);
  });

  test("refuses an address that does not come from the deployment's key, without linking or calling AVNU", async () => {
    let executed = false;
    const attached: unknown[] = [];
    const other = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
    const app = appWith({ executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } }, [], { accountId: "acct-1", attached });
    const res = await app.request("/deploy/execute", {
      ...post,
      body: JSON.stringify({ ownerAddress: other, typedData: outsideExecutionTypedData(deploymentCalls(other)), signature: ["0x1"], deployment: walletDeployment(other) }),
    });
    expect(res.status).toBe(400);
    expect(executed).toBe(false);
    expect(attached).toEqual([]);
  });

  test("refuses a caller with no account session without calling AVNU", async () => {
    let executed = false;
    const attached: unknown[] = [];
    const app = appWith({ executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } }, [], { attached });
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(401);
    expect(executed).toBe(false);
    expect(attached).toEqual([]);
  });

  test("keeps the link when AVNU refuses, so a retry creates the same wallet", async () => {
    const attached: unknown[] = [];
    const app = appWith({ executeTransaction: async () => { throw new Error("TRANSACTION_EXECUTION_ERROR"); } }, [], { accountId: "acct-1", attached });
    const res = await app.request("/deploy/execute", { ...post, body: deployBody() });
    expect(res.status).toBe(422);
    expect(attached).toEqual([{ accountId: "acct-1", appId: "MEDIALANE_API", chain: "STARKNET", address: OWNER_ADDRESS }]);
  });

  test("refuses a signature for other calls without calling AVNU", async () => {
    let executed = false;
    const classHash = getCoordinates("STARKNET").mediaWalletClassHash!;
    const app = appWith({ executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } });
    const res = await app.request("/deploy/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerAddress: OWNER_ADDRESS, typedData: outsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"], deployment: { address: OWNER_ADDRESS, class_hash: classHash } }),
    });
    expect(res.status).toBe(400);
    expect(executed).toBe(false);
  });
});

describe("Media Wallet deployment check", () => {
  const CH = MEDIA_WALLET_CLASS;
  const OWNER = DERIVED_ADDRESS;

  test("accepts a Media Wallet deployment at the address its key produces", () => {
    expect(deploymentIsMediaWallet(walletDeployment(), OWNER, CH)).toBe(true);
  });

  test("refuses another class or another address", () => {
    expect(deploymentIsMediaWallet({ ...walletDeployment(), class_hash: "0x123" }, OWNER, CH)).toBe(false);
    expect(deploymentIsMediaWallet(walletDeployment("0x9"), OWNER, CH)).toBe(false);
    expect(deploymentIsMediaWallet(null, OWNER, CH)).toBe(false);
  });

  test("refuses an address that its salt and constructor data do not produce", () => {
    const other = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(deploymentIsMediaWallet(walletDeployment(other), other, CH)).toBe(false);
    expect(deploymentIsMediaWallet({ address: OWNER, class_hash: CH }, OWNER, CH)).toBe(false);
  });
});

describe("upstream failures", () => {
  test("a paymaster error becomes a 502, not an unhandled throw", async () => {
    const res = await intentApp([signedRow], { buildTransaction: async () => { throw new Error("paymaster down"); } }, [])
      .request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(502);
  });
});

describe("sponsored calls are never refused for volume", () => {
  test("a wallet's 61st sponsored build in a minute still reaches the paymaster", async () => {
    let built = 0;
    const app = intentApp([signedRow], { buildTransaction: async () => { built += 1; return { typed_data: { message: "td" } } as never; } }, []);
    for (let i = 0; i < 61; i++) {
      const res = await app.request("/invoke/build", postJson({ intentIds: ["i1"] }));
      expect(res.status).toBe(200);
    }
    expect(built).toBe(61);
  });
});

describe("every sponsorship failure says why it failed", () => {
  test("a malformed intent list is invalid_request", async () => {
    const res = await intentApp([signedRow], {}, []).request("/invoke/build", postJson({ intentIds: "i1" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_request");
  });

  test("a sponsor that cannot build is sponsor_unavailable", async () => {
    const res = await intentApp([signedRow], { buildTransaction: async () => { throw new Error("fetch failed"); } }, [])
      .request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe("sponsor_unavailable");
  });
});

const WALLET = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function intentApp(rows: SponsorIntentRow[], client: Partial<PaymasterClient>, log: string[], wallet: string | null = WALLET, cosign?: Cosign) {
  const stub: PaymasterClient = {
    buildTransaction: async () => ({ typed_data: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]) }) as never,
    executeTransaction: async () => ({ transaction_hash: "0xtx" }) as never,
    ...client,
  };
  const intentDeps: SponsorIntentDeps = {
    load: async (ids) => rows.filter((r) => ids.includes(r.id)),
    claim: async (ids) => { log.push(`claim:${ids}`); return true; },
    release: async (ids) => { log.push(`release:${ids}`); },
    record: async (ids, tx) => { log.push(`record:${ids}:${tx}`); },
    known: async (addresses) => new Set(addresses.filter((a) => BigInt(a) === BigInt(SPONSORABLE_CALL.contractAddress))),
    now: () => new Date(),
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("account", { id: "app", status: "ACTIVE" } as never);
    if (wallet) c.set("sponsorWallet", wallet);
    await next();
  });
  app.route("/", paymaster(() => stub, (_c, next) => next(), intentDeps, undefined, cosign));
  return app;
}

const signedRow: SponsorIntentRow = {
  id: "i1", type: "MINT", accountId: "app", requester: WALLET, status: "SIGNED", expiresAt: new Date(Date.now() + 60_000), calls: [SPONSORABLE_CALL],
};
const postJson = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("work that was sent is charged even when the response is an error", () => {
  test("an invoke that may have been sent keeps one credit and its intents", async () => {
    const log: string[] = [];
    const { app, credits } = billing(intentApp([signedRow], { executeTransaction: async () => { throw new Error("socket hang up"); } }, log));
    const res = await app.request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"] }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe("may_have_broadcast");
    expect(credits).toEqual([1]);
    expect(log.some((l) => l.startsWith("release:"))).toBe(false);
  });

  test("an invoke the sponsor refused to run names no credits", async () => {
    const { app, credits } = billing(intentApp([signedRow], { executeTransaction: async () => { throw new Error("TRANSACTION_EXECUTION_ERROR"); } }, []));
    const res = await app.request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"] }));
    expect(res.status).toBe(422);
    expect(credits).toEqual([undefined]);
  });
});

describe("a wallet with a guardian", () => {
  const executedWith = (cosign?: Cosign) => {
    const seen: unknown[] = [];
    const app = intentApp([signedRow], { executeTransaction: async (req) => { seen.push((req as { invoke: { signature: string[] } }).invoke.signature); return { transaction_hash: "0xtx" } as never; } }, [], WALLET, cosign);
    return { app, seen };
  };
  const body = { intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1", "0x2"] };

  test("the sponsor runs the co-signed signature, built from the same wallet and typed data", async () => {
    const asked: unknown[] = [];
    const { app, seen } = executedWith(async (wallet, typedData, signature) => { asked.push({ wallet, typedData, signature }); return [...signature, "0x3", "0x4"]; });
    expect((await app.request("/invoke/execute", postJson(body))).status).toBe(200);
    expect(seen).toEqual([["0x1", "0x2", "0x3", "0x4"]]);
    expect(asked).toEqual([{ wallet: WALLET, typedData: body.typedData, signature: ["0x1", "0x2"] }]);
  });

  test("a wallet without one runs exactly the signature the client sent", async () => {
    const { app, seen } = executedWith();
    expect((await app.request("/invoke/execute", postJson(body))).status).toBe(200);
    expect(seen).toEqual([["0x1", "0x2"]]);
  });
});

describe("intent sponsorship", () => {
  test("build sponsors the stored calls for the caller's wallet", async () => {
    const seen: unknown[] = [];
    const res = await intentApp([signedRow], { buildTransaction: async (req) => { seen.push(req); return { typed_data: { t: 1 } } as never; } }, [])
      .request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ type: "invoke", invoke: { userAddress: WALLET, calls: [SPONSORABLE_CALL] } }]);
  });

  test("execute refuses typed data for other calls and never calls AVNU", async () => {
    let executed = false;
    const res = await intentApp([signedRow], { executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } }, [])
      .request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([{ ...SPONSORABLE_CALL, entrypoint: "transfer" }]), signature: ["0x1"] }));
    expect(res.status).toBe(400);
    expect(executed).toBe(false);
  });

  test("execute claims, sponsors and records the intents", async () => {
    const log: string[] = [];
    const res = await intentApp([signedRow], {}, log)
      .request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"] }));
    expect(res.status).toBe(200);
    expect(log).toEqual(["claim:i1", "record:i1:0xtx"]);
  });

  test("a failed execute puts the intents back", async () => {
    const log: string[] = [];
    const res = await intentApp([signedRow], { executeTransaction: async () => { throw new Error("TRANSACTION_EXECUTION_ERROR"); } }, log)
      .request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"] }));
    expect(res.status).toBe(422);
    expect(log).toEqual(["claim:i1", "release:i1"]);
  });

  test("an execute that may have broadcast keeps the intents claimed", async () => {
    const log: string[] = [];
    const res = await intentApp([signedRow], { executeTransaction: async () => { throw new Error("socket hang up"); } }, log)
      .request("/invoke/execute", postJson({ intentIds: ["i1"], typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"] }));
    expect(res.status).toBe(502);
    expect(log).toEqual(["claim:i1"]);
  });

  test("an intent of another app is refused", async () => {
    const res = await intentApp([{ ...signedRow, accountId: "other" }], {}, []).request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(403);
  });

  test("an intent of another wallet is refused", async () => {
    const res = await intentApp([{ ...signedRow, requester: "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321" }], {}, [])
      .request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(403);
  });

  test("a call to an unknown contract gets sponsor_unavailable so the client falls back to paying", async () => {
    const res = await intentApp([{ ...signedRow, calls: [{ ...SPONSORABLE_CALL, contractAddress: "0x666" }] }], {}, [])
      .request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("sponsor_unavailable");
  });

  test("an account with no wallet can't be sponsored", async () => {
    const res = await intentApp([signedRow], {}, [], null).request("/invoke/build", postJson({ intentIds: ["i1"] }));
    expect(res.status).toBe(403);
  });
});

describe("raw calls are no longer sponsored", () => {
  test("a raw-calls build gets sponsor_unavailable so old clients fall back to paying", async () => {
    const res = await intentApp([], {}, []).request("/invoke/build", postJson({ userAddress: WALLET, calls: [SPONSORABLE_CALL] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Sponsorship needs intents", code: "sponsor_unavailable" });
  });

  test("a raw-calls execute gets sponsor_unavailable and never reaches AVNU", async () => {
    let executed = false;
    const res = await intentApp([], { executeTransaction: async () => { executed = true; return { transaction_hash: "0x1" } as never; } }, [])
      .request("/invoke/execute", postJson({ userAddress: WALLET, typedData: sponsoredOutsideExecutionTypedData([SPONSORABLE_CALL]), signature: ["0x1"] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("sponsor_unavailable");
    expect(executed).toBe(false);
  });
});
