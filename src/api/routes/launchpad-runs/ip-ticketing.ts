import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../../types/hono.js";
import { createLogger } from "../../../utils/logger.js";
import { normalizeAddress } from "../../../utils/starknet.js";
import { IDENTITY_SCHEME } from "../../../utils/identity.js";
import { COLLECTION_DEPLOYED_SELECTOR } from "../../../config/constants.js";
import type { StoredRun } from "../../../launchpad/run-store.js";
import { parseRunSpec, stepCredits } from "../../../launchpad/services/index.js";
import type { IpTicketingSpec } from "../../../launchpad/services/ip-ticketing/definition.js";
import { TICKET_CREATED_SELECTOR, type Call } from "../../../launchpad/services/ip-ticketing/chain.js";
import {
  batchCount,
  batchGuests,
  collectionAddressOf,
  readProgress,
  ticketMetadata,
  type IpTicketingProgress,
} from "../../../launchpad/services/ip-ticketing/progress.js";
import { canSubmit, pinnedValue, type StepState } from "../../../launchpad/services/data-tokenization/progress.js";
import { buildSponsoredInvoke } from "../paymaster.js";
import { executeBody, indexParam, ownsWallet, walletBody, type ReceiptEvent, type RunContext, type RunReceipt } from "./context.js";
import { confirmStep, executeStep } from "./sponsored-step.js";

const log = createLogger("routes:launchpad-runs:ip-ticketing");

const SERVICE = "ip-ticketing";

/** Data Tokenization owns the un-prefixed step paths, so this service's steps live under their own. */
const BASE = "/:id/ticketing";

export const MAX_ARTWORK_UPLOAD_URLS = 3;

const fileNameBody = z.object({ name: z.string().min(1).max(255) });
const uploadedBody = z.object({ name: z.string().min(1).max(255), cid: z.string().min(10).max(120) });
const walletRequest = z.object({
  recipient: z.string().email(),
  interimOwnerPubkey: z.string(),
  derivationSalt: z.string().min(16).max(128),
  deployment: z.object({ typedData: z.unknown(), signature: z.array(z.string()).min(1), deployment: z.unknown() }),
});

class NotReady extends Error {}

interface ActiveRun {
  run: StoredRun;
  apiClientId: string;
  spec: IpTicketingSpec;
  progress: IpTicketingProgress;
}

const sameFelt = (a: string | undefined, b: string | undefined) => {
  if (!a || !b) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};

export function createdCollectionAddress(events: ReceiptEvent[], factory: string): string | null {
  for (const event of events) {
    if (!sameFelt(event.from_address, factory) || !sameFelt(event.keys?.[0], COLLECTION_DEPLOYED_SELECTOR)) continue;
    const address = event.keys?.[1];
    if (address && BigInt(address) !== 0n) return normalizeAddress("STARKNET", address);
  }
  return null;
}

export function createdTicketId(events: ReceiptEvent[], collection: string): string | null {
  for (const event of events) {
    if (!sameFelt(event.from_address, collection) || !sameFelt(event.keys?.[0], TICKET_CREATED_SELECTOR)) continue;
    const low = event.keys?.[1];
    if (!low) continue;
    return (BigInt(low) + (BigInt(event.keys?.[2] ?? "0x0") << 128n)).toString();
  }
  return null;
}

interface SponsoredStep {
  route: string;
  indexed?: boolean;
  label: string;
  path(index: number): string[];
  credits(active: ActiveRun, index: number): Promise<number>;
  /** False once the step is on its way or done. */
  open(active: ActiveRun, index: number): boolean;
  calls(active: ActiveRun, index: number, owner: string): Promise<Call[]>;
  state(active: ActiveRun, index: number): StepState | undefined;
  succeeded(active: ActiveRun, index: number, receipt: RunReceipt, txHash: string, c: Context<AppEnv>): Promise<Response>;
}

export function createIpTicketingRoutes(ctx: RunContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const ex = () => ctx.execution();
  const chain = () => ctx.ticketing();

  const loadActive = async (c: Context<AppEnv>): Promise<ActiveRun | Response> => {
    const apiClientId = c.get("apiClient").id;
    const run = await ctx.store.get(c.req.param("id") ?? "", apiClientId);
    if (!run) return c.json({ error: "Run not found" }, 404);
    if (run.service !== SERVICE) return c.json({ error: "This run does not issue tickets" }, 400);
    if (run.status !== "PAID" && run.status !== "RUNNING") {
      return c.json({ error: "This run is not ready to execute" }, 409);
    }
    const parsed = parseRunSpec(run.service, run.spec);
    if (parsed.service !== SERVICE) return c.json({ error: "This run does not issue tickets" }, 400);
    return { run, apiClientId, spec: parsed.spec, progress: readProgress(run.progress) };
  };

  const notReady = (c: Context<AppEnv>, err: unknown) => {
    log.warn({ err }, "run step not ready");
    return c.json({ error: "This step is not ready" }, 409);
  };

  const record = (active: ActiveRun, path: string[], value: unknown) =>
    ctx.store.record(active.run.id, active.apiClientId, path, value);

  const collectionOf = (active: ActiveRun) => {
    const address = collectionAddressOf(active.spec, active.progress);
    if (!address) throw new NotReady("Create the collection first");
    return normalizeAddress("STARKNET", address);
  };

  const ticketIdOf = (active: ActiveRun) => {
    const ticketId = active.progress.tier?.ticketId;
    if (!ticketId) throw new NotReady("Create the ticket type first");
    return ticketId;
  };

  const steps: SponsoredStep[] = [
    {
      route: "collection",
      label: "The collection",
      path: () => ["collection", "tx"],
      credits: () => stepCredits(SERVICE, "collection", 0, ctx.priceOf),
      open: (active) => !active.progress.collection?.address && canSubmit(active.progress.collection?.tx),
      async calls(active, _index, owner) {
        const choice = active.spec.collection;
        if (choice.kind !== "new") throw new NotReady("This run uses an existing collection");
        let baseUri = active.progress.collection?.baseUri;
        if (!baseUri) {
          baseUri = await ex().pinJson({ name: choice.name, external_link: "https://medialane.io" });
          active.progress.collection = { ...active.progress.collection, baseUri };
          await record(active, ["collection", "baseUri"], baseUri);
        }
        return chain().collectionCalls({ owner, name: choice.name, symbol: choice.symbol, baseUri });
      },
      state: (active) => active.progress.collection?.tx,
      async succeeded(active, _index, receipt, txHash, c) {
        const address = createdCollectionAddress(receipt.events, chain().factory());
        if (!address) {
          log.error({ run: active.run.id, txHash }, "collection created but its address was not in the receipt");
          return c.json({ error: "The collection was created but its address could not be read yet. Try again shortly." }, 502);
        }
        await record(active, ["collection", "tx"], { txHash, status: "SUCCEEDED" });
        await record(active, ["collection", "address"], address);
        return c.json({ data: { status: "SUCCEEDED", collectionAddress: address } });
      },
    },
    {
      route: "tier",
      label: "The ticket type",
      path: () => ["tier", "tx"],
      credits: () => stepCredits(SERVICE, "tier", 0, ctx.priceOf),
      open: (active) => !active.progress.tier?.ticketId && canSubmit(active.progress.tier?.tx),
      async calls(active, _index, owner) {
        const collection = collectionOf(active);
        const metadataUri = pinnedValue(active.progress.tokenUri);
        if (!metadataUri) throw new NotReady("Store the ticket's metadata first");
        const { spec } = active;
        return chain().tierCalls({
          owner,
          collection,
          maxSupply: String(spec.supply ?? spec.guests.length),
          royaltyBps: Math.round(spec.terms.royalty * 100),
          metadataUri,
          startTime: spec.validFrom,
          endTime: spec.validUntil,
        });
      },
      state: (active) => active.progress.tier?.tx,
      async succeeded(active, _index, receipt, txHash, c) {
        const ticketId = createdTicketId(receipt.events, collectionOf(active));
        if (!ticketId) {
          log.error({ run: active.run.id, txHash }, "ticket type created but its id was not in the receipt");
          return c.json({ error: "The ticket type was created but its id could not be read yet. Try again shortly." }, 502);
        }
        await record(active, ["tier", "tx"], { txHash, status: "SUCCEEDED" });
        await record(active, ["tier", "ticketId"], ticketId);
        return c.json({ data: { status: "SUCCEEDED", ticketId } });
      },
    },
    {
      route: "batches/:index",
      indexed: true,
      label: "This batch",
      path: (index) => ["batches", String(index)],
      credits: (active, index) => stepCredits(SERVICE, "emission", batchGuests(active.spec, index).length, ctx.priceOf),
      open: (active, index) => canSubmit(active.progress.batches[String(index)]),
      async calls(active, index, owner) {
        const guests = batchGuests(active.spec, index);
        if (guests.length === 0) throw new NotReady("There is no such batch in this run");
        const collection = collectionOf(active);
        const ticketId = ticketIdOf(active);
        const calls: Call[] = [];
        for (const guest of guests) {
          const recipient = pinnedValue(active.progress.wallets[guest]);
          if (!recipient) throw new NotReady("This batch is waiting for its guests' wallets");
          calls.push(...(await chain().mintCalls({ owner, recipient, collection, ticketId })));
        }
        return calls;
      },
      state: (active, index) => active.progress.batches[String(index)],
      async succeeded(active, index, _receipt, txHash, c) {
        const path = ["batches", String(index)];
        await record(active, path, { txHash, status: "SUCCEEDED" });
        const batches = { ...active.progress.batches, [String(index)]: { txHash, status: "SUCCEEDED" as const } };
        const remaining = Array.from({ length: batchCount(active.spec) }, (_, i) => batches[String(i)]).some(
          (batch) => batch?.status !== "SUCCEEDED",
        );
        if (remaining) return c.json({ data: { index, status: "SUCCEEDED", completed: false } });
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

  for (const step of steps) {
    const indexOf = (c: Context<AppEnv>) => (step.indexed ? indexParam(c) : 0);

    app.post(`${BASE}/${step.route}/build`, async (c) => {
      const active = await loadActive(c);
      if (active instanceof Response) return active;
      const index = indexOf(c);
      if (index === null) return c.json({ error: "No such batch in this run" }, 404);

      const body = walletBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "userAddress is required" }, 400);
      if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
      if (!step.open(active, index)) return c.json({ error: `${step.label} is already on its way` }, 409);

      let calls: Call[];
      try {
        calls = await step.calls(active, index, body.data.userAddress);
      } catch (err) {
        if (err instanceof NotReady) return notReady(c, err);
        log.warn({ err, run: active.run.id }, "run step could not be prepared");
        return c.json({ error: `Could not prepare ${step.label.toLowerCase()}. Try again.` }, 502);
      }
      const outcome = await buildSponsoredInvoke(ex().sponsored, { userAddress: body.data.userAddress, calls });
      return c.json(outcome.body, outcome.status);
    });

    app.post(`${BASE}/${step.route}/execute`, async (c) => {
      const active = await loadActive(c);
      if (active instanceof Response) return active;
      const index = indexOf(c);
      if (index === null) return c.json({ error: "No such batch in this run" }, 404);

      const body = executeBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "userAddress, typedData and signature are required" }, 400);
      if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);
      if (!step.open(active, index)) return c.json({ error: `${step.label} is already on its way` }, 409);

      let calls: Call[];
      try {
        calls = await step.calls(active, index, body.data.userAddress);
      } catch (err) {
        if (err instanceof NotReady) return notReady(c, err);
        log.warn({ err, run: active.run.id }, "run step could not be prepared");
        return c.json({ error: `Could not prepare ${step.label.toLowerCase()}. Try again.` }, 502);
      }

      return executeStep(ctx, c, {
        runId: active.run.id,
        apiClientId: active.apiClientId,
        path: step.path(index),
        credits: await step.credits(active, index),
        label: step.label,
        ...body.data,
        calls,
      });
    });

    app.post(`${BASE}/${step.route}/confirm`, async (c) => {
      const active = await loadActive(c);
      if (active instanceof Response) return active;
      const index = indexOf(c);
      if (index === null) return c.json({ error: "No such batch in this run" }, 404);

      return confirmStep(ctx, c, {
        runId: active.run.id,
        apiClientId: active.apiClientId,
        path: step.path(index),
        credits: await step.credits(active, index),
        label: step.label,
        state: step.state(active, index),
        extra: step.indexed ? { index } : undefined,
        onSucceeded: (receipt, txHash) => step.succeeded(active, index, receipt, txHash, c),
      });
    });
  }

  app.post(`${BASE}/files/upload-url`, async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = fileNameBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name is required" }, 400);
    const { name } = body.data;
    const artwork = active.spec.artwork;
    if (!artwork || artwork.name !== name) return c.json({ error: `${name} is not part of this run` }, 400);
    if (pinnedValue(active.progress.artwork)) return c.json({ error: `${name} is already uploaded` }, 409);

    const issued = active.progress.uploadUrls ?? 0;
    if (issued >= MAX_ARTWORK_UPLOAD_URLS) {
      return c.json({ error: `${name} has had too many upload attempts. Contact support to continue.` }, 429);
    }
    await record(active, ["uploadUrls"], issued + 1);

    try {
      const url = await ex().signedUpload({
        name,
        size: artwork.size,
        type: artwork.type,
        keyvalues: { run: active.run.id, file: name },
      });
      return c.json({ data: { name, url } }, 201);
    } catch (err) {
      log.warn({ err, run: active.run.id, file: name }, "run signed upload failed");
      return c.json({ error: "Could not prepare this upload. Try again." }, 502);
    }
  });

  app.post(`${BASE}/files/uploaded`, async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = uploadedBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name and cid are required" }, 400);
    const { name, cid } = body.data;
    const artwork = active.spec.artwork;
    if (!artwork || artwork.name !== name) return c.json({ error: `${name} is not part of this run` }, 400);

    const pinned = await ex().pinnedFile(cid);
    if (!pinned || pinned.size !== artwork.size || pinned.keyvalues.run !== active.run.id || pinned.keyvalues.file !== name) {
      return c.json({ error: `That upload does not match ${name}` }, 409);
    }

    const credits = await stepCredits(SERVICE, "file", 1, ctx.priceOf);
    const path = ["artwork"];
    if (!(await ctx.store.reserve({ id: active.run.id, apiClientId: active.apiClientId, credits, path }))) {
      return c.json({ error: `${name} is already uploaded` }, 409);
    }
    const uri = `ipfs://${cid}`;
    await record(active, path, uri);
    return c.json({ data: { name, uri } }, 201);
  });

  app.post(`${BASE}/metadata`, async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = walletBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "userAddress is required" }, 400);
    if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);

    let metadata: Record<string, unknown>;
    try {
      metadata = { ...ticketMetadata(active.spec, active.progress, normalizeAddress("STARKNET", body.data.userAddress)) };
    } catch {
      return c.json({ error: "The ticket is waiting for its artwork" }, 409);
    }

    const credits = await stepCredits(SERVICE, "metadata", 1, ctx.priceOf);
    const path = ["tokenUri"];
    if (!(await ctx.store.reserve({ id: active.run.id, apiClientId: active.apiClientId, credits, path }))) {
      return c.json({ error: "The ticket's metadata is already stored" }, 409);
    }
    try {
      const tokenUri = await ex().pinJson(metadata);
      await record(active, path, tokenUri);
      return c.json({ data: { tokenUri } }, 201);
    } catch (err) {
      await ctx.store.release({ id: active.run.id, apiClientId: active.apiClientId, credits, path });
      log.warn({ err, run: active.run.id }, "run metadata pin failed");
      return c.json({ error: "Could not store the ticket's metadata. Try again." }, 502);
    }
  });

  app.post(`${BASE}/wallets/resolve`, async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const waiting = active.spec.guests.filter((guest) => active.progress.wallets[guest] === undefined);
    const resolved = waiting.length > 0 ? await chain().resolveWallets(waiting) : [];
    const pending: string[] = [];
    for (const { recipientValue, walletAddress } of resolved) {
      if (walletAddress) await record(active, ["wallets", recipientValue], walletAddress);
      else pending.push(recipientValue);
    }
    return c.json({ data: { pending } });
  });

  app.post(`${BASE}/wallets`, async (c) => {
    const active = await loadActive(c);
    if (active instanceof Response) return active;

    const body = walletRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "recipient, interimOwnerPubkey, derivationSalt and deployment are required" }, 400);
    const recipient = body.data.recipient.trim().toLowerCase();
    if (!active.spec.guests.includes(recipient)) return c.json({ error: `${recipient} is not on this run's guest list` }, 400);

    const credits = await stepCredits(SERVICE, "wallet", 1, ctx.priceOf);
    const path = ["wallets", recipient];
    if (!(await ctx.store.reserve({ id: active.run.id, apiClientId: active.apiClientId, credits, path }))) {
      return c.json({ error: `${recipient} already has a wallet on the way` }, 409);
    }

    const apiClient = c.get("apiClient");
    let result;
    try {
      result = await chain().registerWallet(
        { id: apiClient.id, accountId: apiClient.accountId },
        { chain: "STARKNET", recipientScheme: IDENTITY_SCHEME.EMAIL, recipientValue: recipient, ...body.data },
      );
    } catch (err) {
      log.warn({ err, run: active.run.id }, "run wallet provisioning failed");
      result = null;
    }
    if (!result || result.status === 502) {
      await ctx.store.release({ id: active.run.id, apiClientId: active.apiClientId, credits, path });
      return c.json({ error: `Could not prepare a wallet for ${recipient}. Try again.` }, 502);
    }

    await record(active, path, result.record.walletAddress);
    return c.json({ data: { recipient, walletAddress: result.record.walletAddress } }, 201);
  });

  return app;
}
