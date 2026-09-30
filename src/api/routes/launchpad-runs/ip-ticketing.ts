import { z } from "zod";
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
import { canSubmit, pinnedValue } from "../../../launchpad/services/data-tokenization/progress.js";
import { buildDeployment } from "../paymaster.js";
import { ownsWallet, walletBody, type ReceiptEvent, type RunContext } from "./context.js";
import { NotReady, type ActiveBase, type RunServiceSteps, type SponsoredStep } from "./steps.js";

const log = createLogger("routes:launchpad-runs:ip-ticketing");

const SERVICE = "ip-ticketing";

const walletBuildRequest = z.object({ ownerPubkey: z.string().min(3), ownerAddress: z.string().min(3) });
const walletRequest = z.object({
  recipient: z.string().email(),
  interimOwnerPubkey: z.string(),
  derivationSalt: z.string().min(16).max(128),
  deployment: z.object({ typedData: z.unknown(), signature: z.array(z.string()).min(1), deployment: z.unknown() }),
});

interface ActiveRun extends ActiveBase {
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



export function ipTicketingSteps(ctx: RunContext): RunServiceSteps<ActiveRun> {
  const ex = () => ctx.execution();
  const chain = () => ctx.ticketing();

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

  const sponsored: SponsoredStep<ActiveRun>[] = [
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

  return {
    service: SERVICE,
    load(run: StoredRun) {
      const parsed = parseRunSpec(run.service, run.spec);
      if (parsed.service !== SERVICE) throw new Error("This run does not issue tickets");
      return { run, apiClientId: run.apiClientId, spec: parsed.spec, progress: readProgress(run.progress) };
    },
    sponsored,
    files: {
      expected: (active, name) => (active.spec.artwork?.name === name ? active.spec.artwork : null),
      uri: (active) => pinnedValue(active.progress.artwork),
      path: () => ["artwork"],
      urlCount: (active) => active.progress.uploadUrls ?? 0,
      urlCountPath: () => ["uploadUrls"],
      credits: () => stepCredits(SERVICE, "file", 1, ctx.priceOf),
    },
    extra(app, { loadActive, notReady }) {
      app.post("/metadata", async (c) => {
        const active = await loadActive(c);
        if (active instanceof Response) return active;

        const body = walletBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "userAddress is required" }, 400);
        if (!(await ownsWallet(ctx, c, body.data.userAddress))) return c.json({ error: "Use a wallet on your own account" }, 403);

        let metadata: Record<string, unknown>;
        try {
          metadata = { ...ticketMetadata(active.spec, active.progress, normalizeAddress("STARKNET", body.data.userAddress)) };
        } catch (err) {
          return notReady(c, err);
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

      app.post("/wallets/resolve", async (c) => {
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

      app.post("/wallets/build", async (c) => {
        const active = await loadActive(c);
        if (active instanceof Response) return active;

        const body = walletBuildRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "ownerPubkey and ownerAddress are required" }, 400);

        const builds = active.progress.walletBuilds ?? 0;
        if (builds >= active.spec.guests.length * 2) {
          return c.json({ error: "Too many wallet attempts for this run. Contact support to continue." }, 429);
        }
        await record(active, ["walletBuilds"], builds + 1);

        const outcome = await buildDeployment({ clientFactory: ex().sponsored.clientFactory }, body.data);
        return c.json(outcome.body, outcome.status);
      });

      app.post("/wallets", async (c) => {
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
    },
  };
}
