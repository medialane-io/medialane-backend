import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { creditsForAction } from "../../payments/pricing.js";
import { uploadFile, uploadJson } from "../../orchestrator/metadataPin.js";
import { parseRunSpec, RUN_SERVICES, type DataTokenizationSpec } from "../../launchpad/run-spec.js";
import { quoteRun, type QuoteDeps } from "../../launchpad/quote.js";
import { prismaRunStore, type RunStore, type StoredRun } from "../../launchpad/run-store.js";
import { creditFromTransaction } from "../../mirror/handlers/treasuryDeposit.js";
import {
  PENDING,
  emptyProgress,
  isExpectedFile,
  itemMetadata,
  itemsInBatch,
  nextStep,
  readProgress,
  type DataTokenizationProgress,
} from "../../launchpad/execution.js";
import {
  dataTokenizationRegistry,
  productionMintCallDeps,
  registryMintCalls,
  type MintCallDeps,
  type RegistryCall,
} from "../../launchpad/mint-calls.js";
import { buildSponsoredInvoke, defaultClient, executeSponsoredInvoke, type SponsoredInvokeDeps } from "./paymaster.js";
import { createContractAddressChecker } from "./paymaster-contract-address.js";

const log = createLogger("routes:launchpad-runs");

export type ReceiptStatus = "SUCCEEDED" | "REVERTED" | "PENDING";

export interface ExecutionDeps {
  pinFile(file: File): Promise<string>;
  pinJson(data: Record<string, unknown>): Promise<string>;
  mintCalls: MintCallDeps;
  sponsored: SponsoredInvokeDeps;
  receiptStatus(txHash: string): Promise<ReceiptStatus>;
  registry(): string;
}

export interface RunRouteDeps {
  store: RunStore;
  priceOf?: QuoteDeps["priceOf"];
  settleWalletPayment?: (txHash: string) => Promise<unknown>;
  execution?: ExecutionDeps;
}

const createBody = z.object({ service: z.enum(RUN_SERVICES), spec: z.unknown() });
const updateBody = z.object({ spec: z.unknown() });
const checkoutBody = z.discriminatedUnion("method", [
  z.object({ method: z.literal("credits") }),
  z.object({ method: z.literal("wallet"), txHash: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/) }),
]);
const walletBody = z.object({ userAddress: z.string().min(3) }).passthrough();
const executeBody = z.object({
  userAddress: z.string().min(3),
  typedData: z.unknown(),
  signature: z.array(z.string()).min(1),
});

function specError(err: unknown) {
  if (err instanceof z.ZodError) {
    return { error: "The run is not complete", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  return { error: "The run is not complete" };
}

class NotReady extends Error {}

async function productionReceiptStatus(txHash: string): Promise<ReceiptStatus> {
  try {
    const receipt = (await callRpc((provider) => provider.getTransactionReceipt(txHash))) as {
      execution_status?: string;
    };
    if (receipt.execution_status === "SUCCEEDED") return "SUCCEEDED";
    if (receipt.execution_status === "REVERTED") return "REVERTED";
    return "PENDING";
  } catch {
    return "PENDING";
  }
}

function productionExecution(): ExecutionDeps {
  return {
    pinFile: uploadFile,
    pinJson: uploadJson,
    mintCalls: productionMintCallDeps,
    sponsored: { clientFactory: defaultClient, addressChecker: createContractAddressChecker(prisma) },
    receiptStatus: productionReceiptStatus,
    registry: dataTokenizationRegistry,
  };
}

interface ActiveRun {
  run: StoredRun;
  spec: DataTokenizationSpec;
  progress: DataTokenizationProgress;
}

const batchState = (progress: DataTokenizationProgress, index: number) =>
  progress.batches[String(index)] as unknown as { txHash: string; status: string } | string | undefined;

const canSubmitBatch = (progress: DataTokenizationProgress, index: number) => {
  const state = batchState(progress, index);
  return state === undefined || (typeof state === "object" && state.status === "REVERTED");
};

export function createRunRoutes(deps: RunRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const settleWalletPayment = deps.settleWalletPayment ?? creditFromTransaction;
  const priceOf = deps.priceOf ?? ((action: string) => creditsForAction(action));
  let execution = deps.execution;
  const ex = () => (execution ??= productionExecution());

  const quoteFor = async (run: StoredRun) =>
    quoteRun(parseRunSpec(run.service, run.spec), {
      priceOf,
      countProvisioned: deps.store.countProvisioned,
    });

  const present = async (run: StoredRun) => {
    if (run.status === "DRAFT") {
      try {
        return { ...run, quote: await quoteFor(run) };
      } catch {
        return { ...run, quote: null };
      }
    }
    if (run.service === "data-tokenization-erc721" && (run.status === "PAID" || run.status === "RUNNING")) {
      const parsed = parseRunSpec(run.service, run.spec);
      if (parsed.service === "data-tokenization-erc721") {
        return { ...run, next: nextStep(parsed.spec, readProgress(run.progress)) };
      }
    }
    return run;
  };

  const loadActive = async (c: Context<AppEnv>): Promise<ActiveRun | Response> => {
    const run = await deps.store.get(c.req.param("id") ?? "", c.get("apiClient").id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    if (run.service !== "data-tokenization-erc721") return c.json({ error: "This run does not tokenize a catalog" }, 400);
    if (run.status !== "PAID" && run.status !== "RUNNING") {
      return c.json({ error: "This run is not ready to execute" }, 409);
    }
    const parsed = parseRunSpec(run.service, run.spec);
    if (parsed.service !== "data-tokenization-erc721") return c.json({ error: "This run does not tokenize a catalog" }, 400);
    return { run, spec: parsed.spec, progress: readProgress(run.progress) };
  };

  const ownWallet = async (c: Context<AppEnv>, address: string) => deps.store.ownsWallet(c.get("account").id, address);

  const batchCalls = async (active: ActiveRun, index: number, owner: string): Promise<RegistryCall[]> => {
    if (active.spec.collection.kind !== "existing") throw new NotReady("Create the collection first");
    const items = itemsInBatch(active.spec, index);
    if (items.length === 0) throw new NotReady("There is no such batch in this run");
    const tokenUris = items.map((i) => active.progress.tokenUris[String(i)]);
    if (tokenUris.some((uri) => !uri || uri === PENDING)) throw new NotReady("This batch is waiting for its metadata");
    return registryMintCalls(ex().mintCalls, {
      registry: ex().registry(),
      collectionId: active.spec.collection.collectionId,
      owner,
      tokenUris: tokenUris as string[],
      royaltyPercent: active.spec.terms.royalty,
    });
  };

  const batchCredits = async (active: ActiveRun, index: number) =>
    (await priceOf("paymaster:invoke-build")) +
    (await priceOf("paymaster:invoke-execute")) +
    (await priceOf("intent:mint")) * itemsInBatch(active.spec, index).length;

  const batchIndex = (c: Context<AppEnv>) => {
    const index = Number(c.req.param("index"));
    return Number.isInteger(index) && index >= 0 ? index : null;
  };

  app.post("/", async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "service and spec are required" }, 400);
    try {
      parseRunSpec(body.data.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await deps.store.create({
      apiClientId: c.get("apiClient").id,
      service: body.data.service,
      spec: body.data.spec,
    });
    return c.json({ data: await present(run) }, 201);
  });

  app.get("/", async (c) => {
    const runs = await deps.store.list(c.get("apiClient").id);
    return c.json({ data: runs });
  });

  app.get("/:id", async (c) => {
    const run = await deps.store.get(c.req.param("id"), c.get("apiClient").id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json({ data: await present(run) });
  });

  app.patch("/:id", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const body = updateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "spec is required" }, 400);

    const existing = await deps.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    if (existing.status !== "DRAFT") return c.json({ error: "A run can only change while it is a draft" }, 409);

    try {
      parseRunSpec(existing.service, body.data.spec);
    } catch (err) {
      return c.json(specError(err), 400);
    }
    const run = await deps.store.updateDraft(existing.id, apiClientId, body.data.spec);
    if (!run) return c.json({ error: "A run can only change while it is a draft" }, 409);
    return c.json({ data: await present(run) });
  });

  app.post("/:id/cancel", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const existing = await deps.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);

    if (existing.status === "DRAFT") {
      const run = await deps.store.cancelDraft(existing.id, apiClientId);
      if (!run) return c.json({ error: "This run has already moved on" }, 409);
      return c.json({ data: run });
    }

    if (existing.status !== "PAID" && existing.status !== "RUNNING") {
      return c.json({ error: "This run is already closed" }, 409);
    }
    const inFlight = Object.values(readProgress(existing.progress).batches).some(
      (b) => typeof b === "string" || b.status === "SUBMITTED",
    );
    if (inFlight) return c.json({ error: "A batch is still being confirmed. Try again once it lands." }, 409);

    const closed = await deps.store.complete({ id: existing.id, apiClientId, status: "CANCELLED", path: c.req.path });
    if (!closed) return c.json({ error: "This run is already closed" }, 409);
    return c.json({ data: { ...(await deps.store.get(existing.id, apiClientId)), refunded: closed.refunded } });
  });

  app.post("/:id/checkout", async (c) => {
    const apiClientId = c.get("apiClient").id;
    const body = checkoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose to pay with credits or from your wallet" }, 400);

    const existing = await deps.store.get(c.req.param("id"), apiClientId);
    if (!existing) return c.json({ error: "Run not found" }, 404);
    if (existing.status !== "DRAFT") return c.json({ error: "This run is already paid" }, 409);

    let quote;
    try {
      quote = await quoteFor(existing);
    } catch (err) {
      return c.json(specError(err), 400);
    }

    let paymentId: string | undefined;
    if (body.data.method === "wallet") {
      await settleWalletPayment(body.data.txHash);
      const found = await deps.store.findPayment(body.data.txHash, apiClientId);
      if (!found) {
        return c.json({ error: "That payment has not reached your account yet. Try again in a moment." }, 402);
      }
      paymentId = found;
    }

    const outcome = await deps.store.checkout({
      id: existing.id,
      apiClientId,
      service: existing.service,
      quote,
      paymentId,
      progress: existing.service === "data-tokenization-erc721" ? emptyProgress() : {},
      path: c.req.path,
    });

    if (outcome === "not-draft") return c.json({ error: "This run is already paid" }, 409);
    if (outcome === "insufficient") {
      const balance = await deps.store.balance(apiClientId);
      return c.json(
        { error: "Not enough credits for this run", data: { total: quote.total, balance, shortfall: quote.total - balance } },
        402,
      );
    }

    const run = await deps.store.get(existing.id, apiClientId);
    return c.json({ data: run ? await present(run) : null });
  });

  app.post("/:id/files", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const apiClientId = c.get("apiClient").id;

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Attach the file to upload" }, 400);
    if (!isExpectedFile(active.spec, file.name, file.size)) {
      return c.json({ error: `${file.name} is not part of this run` }, 400);
    }

    const credits = await priceOf("metadata:upload-file");
    const path = ["files", file.name];
    if (!(await deps.store.reserve({ id: active.run.id, apiClientId, credits, path }))) {
      return c.json({ error: `${file.name} is already uploaded` }, 409);
    }
    try {
      const uri = await ex().pinFile(file);
      await deps.store.record(active.run.id, apiClientId, path, uri);
      return c.json({ data: { name: file.name, uri } }, 201);
    } catch (err) {
      await deps.store.release({ id: active.run.id, apiClientId, credits, path });
      log.warn({ err, run: active.run.id, file: file.name }, "run file upload failed");
      return c.json({ error: "Could not store that file. Try again." }, 502);
    }
  });

  app.post("/:id/items/:index/metadata", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const apiClientId = c.get("apiClient").id;

    const index = batchIndex(c);
    if (index === null || !active.spec.items[index]) return c.json({ error: "No such item in this run" }, 404);

    const body = walletBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress is required" }, 400);
    if (!(await ownWallet(c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);

    let metadata: Record<string, unknown>;
    try {
      metadata = itemMetadata(active.spec, index, active.progress, normalizeAddress("STARKNET", body.data.userAddress));
    } catch {
      return c.json({ error: "This item is waiting for its files" }, 409);
    }

    const credits = await priceOf("metadata:upload-json");
    const path = ["tokenUris", String(index)];
    if (!(await deps.store.reserve({ id: active.run.id, apiClientId, credits, path }))) {
      return c.json({ error: "This item's metadata is already stored" }, 409);
    }
    try {
      const tokenUri = await ex().pinJson(metadata);
      await deps.store.record(active.run.id, apiClientId, path, tokenUri);
      return c.json({ data: { index, tokenUri } }, 201);
    } catch (err) {
      await deps.store.release({ id: active.run.id, apiClientId, credits, path });
      log.warn({ err, run: active.run.id, index }, "run metadata pin failed");
      return c.json({ error: "Could not store this item's metadata. Try again." }, 502);
    }
  });

  app.get("/:id/batches/:index", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const index = batchIndex(c);
    const userAddress = c.req.query("userAddress");
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);
    if (!userAddress || !(await ownWallet(c, userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    try {
      return c.json({ data: { index, calls: await batchCalls(active, index, userAddress) } });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "This batch is not ready" }, 409);
    }
  });

  app.post("/:id/batches/:index/build", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const index = batchIndex(c);
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);

    const body = walletBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress is required" }, 400);
    if (!(await ownWallet(c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    if (!canSubmitBatch(active.progress, index)) return c.json({ error: "This batch is already on its way" }, 409);

    let calls: RegistryCall[];
    try {
      calls = await batchCalls(active, index, body.data.userAddress);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "This batch is not ready" }, 409);
    }
    const outcome = await buildSponsoredInvoke(ex().sponsored, { userAddress: body.data.userAddress, calls });
    return c.json(outcome.body, outcome.status);
  });

  app.post("/:id/batches/:index/execute", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const apiClientId = c.get("apiClient").id;
    const index = batchIndex(c);
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);

    const body = executeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress, typedData and signature are required" }, 400);
    if (!(await ownWallet(c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    if (!canSubmitBatch(active.progress, index)) return c.json({ error: "This batch is already on its way" }, 409);

    let calls: RegistryCall[];
    try {
      calls = await batchCalls(active, index, body.data.userAddress);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "This batch is not ready" }, 409);
    }

    const credits = await batchCredits(active, index);
    const path = ["batches", String(index)];
    if (!(await deps.store.reserve({ id: active.run.id, apiClientId, credits, path, retryReverted: true }))) {
      return c.json({ error: "This batch is already on its way" }, 409);
    }

    const outcome = await executeSponsoredInvoke(ex().sponsored, {
      userAddress: body.data.userAddress,
      typedData: body.data.typedData,
      signature: body.data.signature,
      calls,
    });
    if (outcome.status !== 200) {
      await deps.store.release({ id: active.run.id, apiClientId, credits, path });
      return c.json(outcome.body, outcome.status);
    }
    const txHash = String(outcome.body.transactionHash);
    await deps.store.record(active.run.id, apiClientId, path, { txHash, status: "SUBMITTED" });
    return c.json({ transactionHash: txHash });
  });

  app.post("/:id/batches/:index/confirm", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const apiClientId = c.get("apiClient").id;
    const index = batchIndex(c);
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);

    const state = batchState(active.progress, index);
    if (typeof state !== "object" || state.status !== "SUBMITTED") {
      return c.json({ error: "This batch has nothing waiting to confirm" }, 409);
    }

    const status = await ex().receiptStatus(state.txHash);
    if (status === "PENDING") return c.json({ data: { index, status } }, 202);

    const path = ["batches", String(index)];
    if (status === "REVERTED") {
      const credits = await batchCredits(active, index);
      await deps.store.release({ id: active.run.id, apiClientId, credits, path });
      await deps.store.record(active.run.id, apiClientId, path, { txHash: state.txHash, status });
      return c.json({ data: { index, status } });
    }

    await deps.store.record(active.run.id, apiClientId, path, { txHash: state.txHash, status });
    const progress = { ...active.progress, batches: { ...active.progress.batches, [String(index)]: { txHash: state.txHash, status } } };
    if (nextStep(active.spec, progress).kind === "done") {
      const closed = await deps.store.complete({ id: active.run.id, apiClientId, status: "COMPLETED", path: c.req.path });
      return c.json({ data: { index, status, completed: true, refunded: closed?.refunded ?? 0 } });
    }
    return c.json({ data: { index, status, completed: false } });
  });

  return app;
}

export const launchpadRuns = createRunRoutes({ store: prismaRunStore });
