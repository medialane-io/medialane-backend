import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../../types/hono.js";
import { createLogger } from "../../../utils/logger.js";
import { normalizeAddress } from "../../../utils/starknet.js";
import { encodeByteArray } from "../../../orchestrator/intent/shared.js";
import { COLLECTION_CREATED_SELECTOR } from "../../../config/constants.js";
import { decodeCollectionCreatedEvent } from "../../../mirror/handlers/collectionCreated.js";
import type { StoredRun } from "../../../launchpad/run-store.js";
import { parseRunSpec, stepCredits } from "../../../launchpad/services/index.js";
import type { DataTokenizationSpec } from "../../../launchpad/services/data-tokenization/definition.js";
import {
  canSubmit,
  collectionIdOf,
  expectedFile,
  itemMetadata,
  itemsInBatch,
  nextStep,
  pinnedValue,
  readProgress,
  uploadedUri,
  type DataTokenizationProgress,
} from "../../../launchpad/services/data-tokenization/progress.js";
import { registryMintCalls, type RegistryCall } from "../../../launchpad/services/data-tokenization/mint-calls.js";
import { buildSponsoredInvoke } from "../paymaster.js";
import { executeBody, indexParam, ownsWallet, walletBody, type ReceiptEvent, type RunContext } from "./context.js";
import { confirmStep, executeStep } from "./sponsored-step.js";

const log = createLogger("routes:launchpad-runs:data-tokenization");

const SERVICE = "data-tokenization-erc721";

export const MAX_UPLOAD_URLS_PER_FILE = 3;

const fileNameBody = z.object({ name: z.string().min(1).max(255) });
const uploadedBody = z.object({ name: z.string().min(1).max(255), cid: z.string().min(10).max(120) });

class NotReady extends Error {}

interface ActiveRun {
  run: StoredRun;
  apiClientId: string;
  spec: DataTokenizationSpec;
  progress: DataTokenizationProgress;
}

const sameFelt = (a: string | undefined, b: string | undefined) => {
  if (!a || !b) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};

export function createdCollectionId(events: ReceiptEvent[], registry: string): string | null {
  for (const event of events) {
    if (!sameFelt(event.from_address, registry) || !sameFelt(event.keys?.[0], COLLECTION_CREATED_SELECTOR)) continue;
    const decoded = decodeCollectionCreatedEvent({ keys: event.keys, data: event.data });
    if (decoded) return decoded.collectionId;
  }
  return null;
}

const notReady = (c: Context<AppEnv>, err: unknown) =>
  c.json({ error: err instanceof Error ? err.message : "This step is not ready" }, 409);

export function createDataTokenizationRoutes(ctx: RunContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const ex = () => ctx.execution();

  const loadActive = async (c: Context<AppEnv>): Promise<ActiveRun | Response> => {
    const apiClientId = c.get("apiClient").id;
    const run = await ctx.store.get(c.req.param("id") ?? "", apiClientId);
    if (!run) return c.json({ error: "Run not found" }, 404);
    if (run.service !== SERVICE) return c.json({ error: "This run does not tokenize a catalog" }, 400);
    if (run.status !== "PAID" && run.status !== "RUNNING") {
      return c.json({ error: "This run is not ready to execute" }, 409);
    }
    const parsed = parseRunSpec(run.service, run.spec);
    if (parsed.service !== SERVICE) return c.json({ error: "This run does not tokenize a catalog" }, 400);
    return { run, apiClientId, spec: parsed.spec, progress: readProgress(run.progress) };
  };

  const batchCalls = async (active: ActiveRun, index: number, owner: string): Promise<RegistryCall[]> => {
    const collectionId = collectionIdOf(active.spec, active.progress);
    if (!collectionId) throw new NotReady("Create the collection first");
    const items = itemsInBatch(active.spec, index);
    if (items.length === 0) throw new NotReady("There is no such batch in this run");
    const tokenUris = items.map((i) => pinnedValue(active.progress.tokenUris[String(i)]));
    if (tokenUris.some((uri) => uri === null)) throw new NotReady("This batch is waiting for its metadata");
    return registryMintCalls(ex().mintCalls, {
      registry: ex().registry(),
      collectionId,
      owner,
      tokenUris: tokenUris as string[],
      royaltyPercent: active.spec.terms.royalty,
    });
  };

  const collectionCalls = (active: ActiveRun) => {
    const choice = active.spec.collection;
    const baseUri = active.progress.collection?.baseUri;
    if (choice.kind !== "new") throw new NotReady("This run uses an existing collection");
    if (!baseUri) throw new NotReady("Prepare the collection first");
    return [
      {
        contractAddress: ex().registry(),
        entrypoint: "create_collection",
        calldata: [...encodeByteArray(choice.name), ...encodeByteArray(choice.symbol), ...encodeByteArray(baseUri)],
      },
    ];
  };

  const collectionClosed = (active: ActiveRun) =>
    Boolean(active.progress.collection?.collectionId) || !canSubmit(active.progress.collection?.tx);

  app.post("/:id/collection/build", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    if (active.spec.collection.kind !== "new") return c.json({ error: "This run uses an existing collection" }, 409);

    const body = walletBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress is required" }, 400);
    if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    if (collectionClosed(active)) return c.json({ error: "The collection is already on its way" }, 409);

    if (!active.progress.collection?.baseUri) {
      try {
        const baseUri = await ex().pinJson({ name: active.spec.collection.name, external_link: "https://medialane.io" });
        active.progress.collection = { ...active.progress.collection, baseUri };
        await ctx.store.record(active.run.id, active.apiClientId, ["collection"], active.progress.collection);
      } catch (err) {
        log.warn({ err, run: active.run.id }, "run collection metadata pin failed");
        return c.json({ error: "Could not prepare the collection. Try again." }, 502);
      }
    }

    const outcome = await buildSponsoredInvoke(ex().sponsored, {
      userAddress: body.data.userAddress,
      calls: collectionCalls(active),
    });
    return c.json(outcome.body, outcome.status);
  });

  app.post("/:id/collection/execute", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = executeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress, typedData and signature are required" }, 400);
    if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    if (collectionClosed(active)) return c.json({ error: "The collection is already on its way" }, 409);

    let calls;
    try {
      calls = collectionCalls(active);
    } catch (err) {
      return notReady(c, err);
    }

    return executeStep(ctx, c, {
      runId: active.run.id,
      apiClientId: active.apiClientId,
      path: ["collection", "tx"],
      credits: await stepCredits(SERVICE, "collection", 0, ctx.priceOf),
      label: "The collection",
      ...body.data,
      calls,
    });
  });

  app.post("/:id/collection/confirm", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const path = ["collection", "tx"];

    return confirmStep(ctx, c, {
      runId: active.run.id,
      apiClientId: active.apiClientId,
      path,
      credits: await stepCredits(SERVICE, "collection", 0, ctx.priceOf),
      label: "The collection",
      state: active.progress.collection?.tx,
      onSucceeded: async (receipt, txHash) => {
        const collectionId = createdCollectionId(receipt.events, ex().registry());
        if (!collectionId) {
          log.error({ run: active.run.id, txHash }, "collection created but its id was not in the receipt");
          return c.json({ error: "The collection was created but its id could not be read yet. Try again shortly." }, 502);
        }
        await ctx.store.record(active.run.id, active.apiClientId, path, { txHash, status: "SUCCEEDED" });
        await ctx.store.record(active.run.id, active.apiClientId, ["collection", "collectionId"], collectionId);
        return c.json({ data: { status: "SUCCEEDED", collectionId } });
      },
    });
  });

  app.post("/:id/files/upload-url", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = fileNameBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name is required" }, 400);
    const { name } = body.data;
    const expected = expectedFile(active.spec, name);
    if (!expected) return c.json({ error: `${name} is not part of this run` }, 400);
    if (uploadedUri(active.progress, name)) return c.json({ error: `${name} is already uploaded` }, 409);

    const issued = active.progress.uploadUrls[name] ?? 0;
    if (issued >= MAX_UPLOAD_URLS_PER_FILE) {
      return c.json({ error: `${name} has had too many upload attempts. Contact support to continue.` }, 429);
    }
    await ctx.store.record(active.run.id, active.apiClientId, ["uploadUrls", name], issued + 1);

    try {
      const url = await ex().signedUpload({
        name,
        size: expected.size,
        type: expected.type,
        keyvalues: { run: active.run.id, file: name },
      });
      return c.json({ data: { name, url } }, 201);
    } catch (err) {
      log.warn({ err, run: active.run.id, file: name }, "run signed upload failed");
      return c.json({ error: "Could not prepare this upload. Try again." }, 502);
    }
  });

  app.post("/:id/files/uploaded", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = uploadedBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name and cid are required" }, 400);
    const { name, cid } = body.data;
    const expected = expectedFile(active.spec, name);
    if (!expected) return c.json({ error: `${name} is not part of this run` }, 400);

    const pinned = await ex().pinnedFile(cid);
    if (!pinned || pinned.size !== expected.size || pinned.keyvalues.run !== active.run.id || pinned.keyvalues.file !== name) {
      return c.json({ error: `That upload does not match ${name}` }, 409);
    }

    const credits = await stepCredits(SERVICE, "file", 1, ctx.priceOf);
    const path = ["files", name];
    if (!(await ctx.store.reserve({ id: active.run.id, apiClientId: active.apiClientId, credits, path }))) {
      return c.json({ error: `${name} is already uploaded` }, 409);
    }
    const uri = `ipfs://${cid}`;
    await ctx.store.record(active.run.id, active.apiClientId, path, uri);
    return c.json({ data: { name, uri } }, 201);
  });

  app.post("/:id/items/:index/metadata", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const index = indexParam(c);
    if (index === null || !active.spec.items[index]) return c.json({ error: "No such item in this run" }, 404);

    const body = walletBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress is required" }, 400);
    if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);

    let metadata: Record<string, unknown>;
    try {
      metadata = itemMetadata(active.spec, index, active.progress, normalizeAddress("STARKNET", body.data.userAddress));
    } catch {
      return c.json({ error: "This item is waiting for its files" }, 409);
    }

    const credits = await stepCredits(SERVICE, "metadata", 1, ctx.priceOf);
    const path = ["tokenUris", String(index)];
    if (!(await ctx.store.reserve({ id: active.run.id, apiClientId: active.apiClientId, credits, path }))) {
      return c.json({ error: "This item's metadata is already stored" }, 409);
    }
    try {
      const tokenUri = await ex().pinJson(metadata);
      await ctx.store.record(active.run.id, active.apiClientId, path, tokenUri);
      return c.json({ data: { index, tokenUri } }, 201);
    } catch (err) {
      await ctx.store.release({ id: active.run.id, apiClientId: active.apiClientId, credits, path });
      log.warn({ err, run: active.run.id, index }, "run metadata pin failed");
      return c.json({ error: "Could not store this item's metadata. Try again." }, 502);
    }
  });

  app.get("/:id/batches/:index", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const index = indexParam(c);
    const userAddress = c.req.query("userAddress");
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);
    if (!userAddress || !(await ownsWallet(ctx, c, userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    try {
      return c.json({ data: { index, calls: await batchCalls(active, index, userAddress) } });
    } catch (err) {
      return notReady(c, err);
    }
  });

  app.post("/:id/batches/:index/build", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const index = indexParam(c);
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);

    const body = walletBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress is required" }, 400);
    if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    if (!canSubmit(active.progress.batches[String(index)])) return c.json({ error: "This batch is already on its way" }, 409);

    let calls: RegistryCall[];
    try {
      calls = await batchCalls(active, index, body.data.userAddress);
    } catch (err) {
      return notReady(c, err);
    }
    const outcome = await buildSponsoredInvoke(ex().sponsored, { userAddress: body.data.userAddress, calls });
    return c.json(outcome.body, outcome.status);
  });

  app.post("/:id/batches/:index/execute", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const index = indexParam(c);
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);

    const body = executeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress, typedData and signature are required" }, 400);
    if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
    if (!canSubmit(active.progress.batches[String(index)])) return c.json({ error: "This batch is already on its way" }, 409);

    let calls: RegistryCall[];
    try {
      calls = await batchCalls(active, index, body.data.userAddress);
    } catch (err) {
      return notReady(c, err);
    }

    return executeStep(ctx, c, {
      runId: active.run.id,
      apiClientId: active.apiClientId,
      path: ["batches", String(index)],
      credits: await stepCredits(SERVICE, "batch", itemsInBatch(active.spec, index).length, ctx.priceOf),
      label: "This batch",
      ...body.data,
      calls,
    });
  });

  app.post("/:id/batches/:index/confirm", async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;
    const index = indexParam(c);
    if (index === null) return c.json({ error: "No such batch in this run" }, 404);
    const path = ["batches", String(index)];

    return confirmStep(ctx, c, {
      runId: active.run.id,
      apiClientId: active.apiClientId,
      path,
      credits: await stepCredits(SERVICE, "batch", itemsInBatch(active.spec, index).length, ctx.priceOf),
      label: "This batch",
      state: active.progress.batches[String(index)],
      extra: { index },
      onSucceeded: async (_receipt, txHash) => {
        await ctx.store.record(active.run.id, active.apiClientId, path, { txHash, status: "SUCCEEDED" });
        const batches = { ...active.progress.batches, [String(index)]: { txHash, status: "SUCCEEDED" as const } };
        if (nextStep(active.spec, { ...active.progress, batches }).kind !== "done") {
          return c.json({ data: { index, status: "SUCCEEDED", completed: false } });
        }
        const closed = await ctx.store.complete({
          id: active.run.id,
          apiClientId: active.apiClientId,
          status: "COMPLETED",
          path: c.req.path,
        });
        return c.json({ data: { index, status: "SUCCEEDED", completed: true, refunded: closed?.refunded ?? 0 } });
      },
    });
  });

  return app;
}
