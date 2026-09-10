import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { IDENTITY_SCHEME } from "../../utils/identity.js";
import { getService } from "@medialane/sdk";
import { buildMintIntent } from "../../orchestrator/intent/index.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { Chain } from "@prisma/client";

export const DEFAULT_BATCH_SIZE = 25;
export const MAX_RECIPIENTS = 500;

export type Call = { contractAddress: string; entrypoint: string; calldata: string[] };

export interface RecipientResolution {
  recipientValue: string;
  walletAddress: string | null;
}

export interface IssuanceDeps {
  resolveWallets: (chain: Chain, scheme: string, values: string[]) => Promise<RecipientResolution[]>;
  buildMintCalls: (input: {
    owner: string;
    recipient: string;
    collectionId?: string;
    collectionContract?: string;
    tokenUri: string;
  }) => Promise<Call[]>;
}

export function normalizeRecipientValue(scheme: string, value: string): string {
  const trimmed = value.trim();
  return scheme === IDENTITY_SCHEME.EMAIL ? trimmed.toLowerCase() : trimmed;
}

export function dedupeRecipients(scheme: string, values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = normalizeRecipientValue(scheme, raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("batch size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function serviceCanMint(serviceId: string): boolean {
  return getService(serviceId)?.capabilities.includes("mint") ?? false;
}

const mintCallsSchema = z
  .object({
    chain: z.enum(["STARKNET"]).default("STARKNET"),
    service: z.string().min(1),
    owner: z.string().min(1),
    recipientScheme: z.string().min(1).default(IDENTITY_SCHEME.EMAIL),
    recipients: z.array(z.string().min(1)).min(1).max(MAX_RECIPIENTS),
    tokenUri: z.string().min(1),
    collectionId: z.string().optional(),
    collectionContract: z.string().optional(),
    batchSize: z.number().int().min(1).max(100).default(DEFAULT_BATCH_SIZE),
  })
  .refine((v) => v.collectionId || v.collectionContract, {
    message: "collectionId or collectionContract is required",
  });

export function createIssuanceRoutes(deps: IssuanceDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/mint-calls", zValidator("json", mintCallsSchema), async (c) => {
    const body = c.req.valid("json");

    if (!serviceCanMint(body.service)) {
      return c.json({ error: "service_cannot_mint", service: body.service }, 400);
    }

    const recipients = dedupeRecipients(body.recipientScheme, body.recipients);
    if (recipients.length === 0) return c.json({ error: "no_recipients" }, 400);

    const resolved = await deps.resolveWallets(body.chain, body.recipientScheme, recipients);

    const unprovisioned = resolved.filter((r) => !r.walletAddress).map((r) => r.recipientValue);
    if (unprovisioned.length > 0) {
      return c.json({ error: "recipients_not_provisioned", recipients: unprovisioned }, 409);
    }

    const owner = normalizeAddress(body.chain, body.owner);
    const calls: Call[] = [];
    for (const r of resolved) {
      const built = await deps.buildMintCalls({
        owner,
        recipient: r.walletAddress!,
        collectionId: body.collectionId,
        collectionContract: body.collectionContract,
        tokenUri: body.tokenUri,
      });
      calls.push(...built);
    }

    const batches = chunk(calls, body.batchSize);

    return c.json({
      data: {
        service: body.service,
        recipientCount: resolved.length,
        callCount: calls.length,
        batches,
      },
    });
  });

  return app;
}

const productionDeps: IssuanceDeps = {
  resolveWallets: async (chain, scheme, values) => {
    const identities = await prisma.identity.findMany({
      where: { scheme, value: { in: values } },
      select: { value: true, accountId: true },
    });
    const accountByValue = new Map(identities.map((i) => [i.value!, i.accountId]));

    const accountIds = [...new Set(accountByValue.values())];
    const wallets = await prisma.identity.findMany({
      where: { accountId: { in: accountIds }, chain, scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { accountId: true, address: true },
    });
    const walletByAccount = new Map<string, string>();
    for (const w of wallets) {
      if (!walletByAccount.has(w.accountId)) walletByAccount.set(w.accountId, w.address!);
    }

    return values.map((value) => {
      const accountId = accountByValue.get(value);
      return {
        recipientValue: value,
        walletAddress: accountId ? (walletByAccount.get(accountId) ?? null) : null,
      };
    });
  },
  buildMintCalls: async (input) => {
    const { calls } = await buildMintIntent({
      owner: input.owner,
      recipient: input.recipient,
      collectionId: input.collectionId,
      collectionContract: input.collectionContract,
      tokenUri: input.tokenUri,
    } as never);
    return calls as Call[];
  },
};

export const issuanceRoutes = createIssuanceRoutes(productionDeps);
