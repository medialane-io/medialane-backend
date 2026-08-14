import { type Chain, type Prisma, type PrismaClient, type TokenStandard } from "@prisma/client";
import { getService, listServices, type ServiceId } from "@medialane/sdk";
import { normalizeAddress } from "./starknet.js";

export function getServiceByMarketplaceAddress(
  address: string | null | undefined,
): ReturnType<typeof getService> {
  if (!address) return undefined;

  const normalized = normalizeAddress("STARKNET", address);
  return listServices().find(
    (svc) =>
      svc.id.startsWith("medialane-marketplace-") &&
      svc.onchain?.STARKNET?.factoryAddress != null &&
      normalizeAddress("STARKNET", svc.onchain.STARKNET.factoryAddress) === normalized,
  );
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function resolveServiceForContract(
  db: Db,
  chain: Chain,
  contractAddress: string,
): Promise<ServiceId | null> {
  const addr = normalizeAddress(chain, contractAddress);
  const collection = await db.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress: addr } },
    select: { service: true },
  });
  return (collection?.service as ServiceId | undefined) ?? null;
}

function assertRegisteredService(service: string): void {
  if (!getService(service)) {
    throw new Error(
      `Unknown service "${service}". Register it in @medialane/sdk services/registry.ts before writing it to the DB.`,
    );
  }
}

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

    claimedBy?: string | null;
    collectionId?: string | null;
    startBlock: bigint;
  },
): Promise<void> {
  assertRegisteredService(params.service);
  const addr = normalizeAddress(params.chain, params.contractAddress);
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

export async function ensureCollectionFromActivity(
  db: Db,
  params: {
    chain: Chain;
    contractAddress: string;
    standard: TokenStandard;
    blockNumber: bigint;
  },
): Promise<void> {
  const addr = normalizeAddress(params.chain, params.contractAddress);
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
