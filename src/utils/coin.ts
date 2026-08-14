import { type Chain, type Prisma, type PrismaClient } from "@prisma/client";
import { getService } from "@medialane/sdk";
import { callRpc as defaultCallRpc } from "./starknet.js";

type Db = PrismaClient | Prisma.TransactionClient;

const COIN_SERVICES = new Set(["creator-coin", "external-erc20"]);

export async function readTotalSupply(
  contractAddress: string,
  deps: { callRpc: typeof defaultCallRpc } = { callRpc: defaultCallRpc },
): Promise<string> {
  const call = (entrypoint: string) =>
    deps.callRpc((provider) => provider.callContract({ contractAddress, entrypoint, calldata: [] }));

  let result: string[];
  try {
    result = await call("total_supply");
  } catch {
    result = await call("totalSupply");
  }
  const low = BigInt(result[0] ?? "0");
  const high = BigInt(result[1] ?? "0");
  return (low + (high << 128n)).toString();
}

export async function upsertCoin(
  db: Db,
  params: {
    chain: Chain;
    contractAddress: string;
    service: string;
    name?: string | null;
    symbol?: string | null;
    decimals?: number | null;
    totalSupply?: string | null;
    description?: string | null;
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
      description: params.description ?? undefined,
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
      description: params.description ?? undefined,
      image: params.image ?? undefined,
      creator: params.creator ?? undefined,
    },
  });
}
