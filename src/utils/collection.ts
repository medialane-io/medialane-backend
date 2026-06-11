import { type Chain, type Prisma, type PrismaClient, type TokenStandard } from "@prisma/client";
import { getService, listServices, type ServiceId } from "@medialane/sdk";
import { normalizeAddress } from "./starknet.js";

/**
 * Resolve a marketplace contract address to its `ServiceDefinition` via the SDK
 * registry — the single source of truth for "what venue is this".
 *
 * Architecture: `01-core-model §X`, `05-service-model §V` forbid string-comparing
 * `event.from_address` to a hard-coded constant to decide ERC-721 vs ERC-1155
 * routing. Callers parsing raw on-chain events should pass `event.from_address`
 * here and read `.standard` off the returned definition. When a new marketplace
 * (auction, bulk-order, coin-trader) ships, register it in
 * `@medialane/sdk` services/registry.ts and every call site routes correctly
 * with zero edits.
 *
 * Returns `undefined` for addresses that aren't a registered marketplace venue.
 */
export function getServiceByMarketplaceAddress(
  address: string | null | undefined,
): ReturnType<typeof getService> {
  if (!address) return undefined;
  const normalized = normalizeAddress(address);
  return listServices().find(
    (svc) =>
      svc.id.startsWith("medialane-marketplace-") &&
      svc.onchain?.factoryAddress != null &&
      normalizeAddress(svc.onchain.factoryAddress) === normalized,
  );
}

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
    /** Set ONLY from trustless sources (on-chain event data) — gates profile edits. */
    claimedBy?: string | null;
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
      claimedBy: params.claimedBy ?? undefined,
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
      claimedBy: params.claimedBy ?? undefined,
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
