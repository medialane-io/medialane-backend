import { type Chain, type Prisma, type PrismaClient, type TokenStandard } from "@prisma/client";
import { getService, type ServiceId } from "@medialane/sdk";
import { normalizeAddress } from "./starknet.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Runtime guard against unregistered service IDs. The compile-time `ServiceId`
 * type on the helper params catches typos already; this throw catches the
 * remaining case where a value flows in dynamically (e.g. from a request body
 * after schema validation).
 */
function assertRegisteredService(service: string): void {
  if (!getService(service)) {
    throw new Error(
      `Unknown service "${service}". Register it in @medialane/sdk services/registry.ts before writing it to the DB.`,
    );
  }
}

/**
 * Upsert a Collection from authoritative factory data -used by indexer
 * factory handlers (CollectionCreated / CollectionDeployed / DropCreated /
 * etc.) and by admin/registration routes that know the service identity
 * with certainty.
 *
 * Service is required and validated against the SDK registry. Standard is
 * required (no UNKNOWN fallback -factory handlers always know).
 */
export async function upsertCollectionFromFactory(
  db: Db,
  params: {
    chain: Chain;
    contractAddress: string;
    service: ServiceId;
    standard: TokenStandard;
    name?: string | null;
    symbol?: string | null;
    baseUri?: string | null;
    owner?: string | null;
    collectionId?: string | null;
    startBlock: bigint;
  },
): Promise<void> {
  assertRegisteredService(params.service);
  const addr = normalizeAddress(params.contractAddress);
  await db.collection.upsert({
    where: { chain_contractAddress: { chain: params.chain, contractAddress: addr } },
    create: {
      chain: params.chain,
      contractAddress: addr,
      service: params.service,
      standard: params.standard,
      name: params.name ?? undefined,
      symbol: params.symbol ?? undefined,
      baseUri: params.baseUri ?? undefined,
      owner: params.owner ?? undefined,
      collectionId: params.collectionId ?? undefined,
      startBlock: params.startBlock,
      metadataStatus: "PENDING",
    },
    update: {
      service: params.service,
      standard: params.standard,
      name: params.name ?? undefined,
      symbol: params.symbol ?? undefined,
      baseUri: params.baseUri ?? undefined,
      owner: params.owner ?? undefined,
      collectionId: params.collectionId ?? undefined,
    },
  });
}

/**
 * Ensure a Collection row exists for activity (transfer or order events)
 * on a contract the indexer hadn't seen before. Defaults service to
 * external-<standard>; factory handlers will overwrite with the correct
 * mip- / pop- / drop- prefix if the contract turns out to be
 * Medialane-deployed.
 *
 * Does NOT touch an existing row -first sighting wins until a factory
 * handler runs.
 */
export async function ensureCollectionFromActivity(
  db: Db,
  params: {
    chain: Chain;
    contractAddress: string;
    standard: TokenStandard;
    blockNumber: bigint;
  },
): Promise<void> {
  const addr = normalizeAddress(params.contractAddress);
  const defaultService =
    params.standard === "ERC1155" ? "external-erc1155" : "external-erc721";
  await db.collection.upsert({
    where: { chain_contractAddress: { chain: params.chain, contractAddress: addr } },
    create: {
      chain: params.chain,
      contractAddress: addr,
      service: defaultService,
      standard: params.standard,
      startBlock: params.blockNumber,
      metadataStatus: "PENDING",
    },
    update: {},
  });
}
