import { type Chain, type Prisma, type PrismaClient } from "@prisma/client";
import { getService } from "@medialane/sdk";

type Db = PrismaClient | Prisma.TransactionClient;

const COIN_SERVICES = new Set(["creator-coin", "external-erc20"]);

/**
 * Upsert a fungible Coin from authoritative on-chain data (factory event or
 * verified sync). The single creation path for `Coin` — mirrors
 * `upsertCollectionFromFactory`'s discipline. `service` must be a registered
 * coin service; a coin is NEVER written to `Collection` (spec 2026-06-14).
 */
export async function upsertCoin(
  db: Db,
  params: {
    chain: Chain;
    contractAddress: string; // already normalized
    service: string;
    name?: string | null;
    symbol?: string | null;
    decimals?: number | null;
    totalSupply?: string | null;
    image?: string | null;
    creator?: string | null;
    startBlock: bigint;
  },
): Promise<void> {
  if (!COIN_SERVICES.has(params.service) || !getService(params.service)) {
    throw new Error(
      `Unknown coin service "${params.service}" (expected creator-coin | external-erc20)`,
    );
  }
  await db.coin.upsert({
    where: { chain_contractAddress: { chain: params.chain, contractAddress: params.contractAddress } },
    create: {
      chain: params.chain,
      contractAddress: params.contractAddress,
      service: params.service,
      standard: "ERC20",
      name: params.name ?? undefined,
      symbol: params.symbol ?? undefined,
      decimals: params.decimals ?? 18,
      totalSupply: params.totalSupply ?? undefined,
      image: params.image ?? undefined,
      creator: params.creator ?? undefined,
      startBlock: params.startBlock,
    },
    update: {
      service: params.service,
      name: params.name ?? undefined,
      symbol: params.symbol ?? undefined,
      decimals: params.decimals ?? undefined,
      totalSupply: params.totalSupply ?? undefined,
      image: params.image ?? undefined,
      creator: params.creator ?? undefined,
    },
  });
}
