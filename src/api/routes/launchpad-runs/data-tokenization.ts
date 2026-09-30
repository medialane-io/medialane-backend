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
import { indexParam, ownsWallet, walletBody, type ReceiptEvent, type RunContext } from "./context.js";
import { NotReady, type ActiveBase, type RunServiceSteps, type SponsoredStep } from "./steps.js";

const log = createLogger("routes:launchpad-runs:data-tokenization");

const SERVICE = "data-tokenization-erc721";

interface ActiveRun extends ActiveBase {
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



export function dataTokenizationSteps(ctx: RunContext): RunServiceSteps<ActiveRun> {
  const ex = () => ctx.execution();

  const record = (active: ActiveRun, path: string[], value: unknown) =>
    ctx.store.record(active.run.id, active.apiClientId, path, value);

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

  const sponsored: SponsoredStep<ActiveRun>[] = [
    {
      route: "collection",
      label: "The collection",
      path: () => ["collection", "tx"],
      credits: () => stepCredits(SERVICE, "collection", 0, ctx.priceOf),
      open: (active) => !active.progress.collection?.collectionId && canSubmit(active.progress.collection?.tx),
      async calls(active) {
        const choice = active.spec.collection;
        if (choice.kind !== "new") throw new NotReady("This run uses an existing collection");
        let baseUri = active.progress.collection?.baseUri;
        if (!baseUri) {
          baseUri = await ex().pinJson({ name: choice.name, external_link: "https://medialane.io" });
          active.progress.collection = { ...active.progress.collection, baseUri };
          await record(active, ["collection"], active.progress.collection);
        }
        return [
          {
            contractAddress: ex().registry(),
            entrypoint: "create_collection",
            calldata: [...encodeByteArray(choice.name), ...encodeByteArray(choice.symbol), ...encodeByteArray(baseUri)],
          },
        ];
      },
      state: (active) => active.progress.collection?.tx,
      async succeeded(active, _index, receipt, txHash, c) {
        const collectionId = createdCollectionId(receipt.events, ex().registry());
        if (!collectionId) {
          log.error({ run: active.run.id, txHash }, "collection created but its id was not in the receipt");
          return c.json({ error: "The collection was created but its id could not be read yet. Try again shortly." }, 502);
        }
        await record(active, ["collection", "tx"], { txHash, status: "SUCCEEDED" });
        await record(active, ["collection", "collectionId"], collectionId);
        return c.json({ data: { status: "SUCCEEDED", collectionId } });
      },
    },
    {
      route: "batches/:index",
      label: "This batch",
      path: (index) => ["batches", String(index)],
      credits: (active, index) => stepCredits(SERVICE, "batch", itemsInBatch(active.spec, index).length, ctx.priceOf),
      open: (active, index) => canSubmit(active.progress.batches[String(index)]),
      calls: batchCalls,
      state: (active, index) => active.progress.batches[String(index)],
      async succeeded(active, index, _receipt, txHash, c) {
        const path = ["batches", String(index)];
        await record(active, path, { txHash, status: "SUCCEEDED" });
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
    },
  ];

  return {
    service: SERVICE,
    load(run: StoredRun) {
      const parsed = parseRunSpec(run.service, run.spec);
      if (parsed.service !== SERVICE) throw new Error("This run does not tokenize a catalog");
      return { run, apiClientId: run.apiClientId, spec: parsed.spec, progress: readProgress(run.progress) };
    },
    sponsored,
    files: {
      expected: (active, name) => expectedFile(active.spec, name),
      uri: (active, name) => uploadedUri(active.progress, name),
      path: (name) => ["files", name],
      urlCount: (active, name) => active.progress.uploadUrls[name] ?? 0,
      urlCountPath: (name) => ["uploadUrls", name],
      credits: () => stepCredits(SERVICE, "file", 1, ctx.priceOf),
    },
    extra(app, { loadActive, notReady }) {
      app.post("/items/:index/metadata", async (c) => {
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
          await record(active, path, tokenUri);
          return c.json({ data: { index, tokenUri } }, 201);
        } catch (err) {
          await ctx.store.release({ id: active.run.id, apiClientId: active.apiClientId, credits, path });
          log.warn({ err, run: active.run.id, index }, "run metadata pin failed");
          return c.json({ error: "Could not store this item's metadata. Try again." }, 502);
        }
      });

      app.get("/batches/:index", async (c) => {
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
    },
  };
}
