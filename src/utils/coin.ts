import { type Chain, type Prisma, type PrismaClient } from "@prisma/client";
import { getService } from "@medialane/sdk";
import { shortString } from "starknet";
import { callRpc as defaultCallRpc } from "./starknet.js";

function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

const COIN_SERVICES = new Set(["creator-coin", "unruggable-erc20", "external-erc20"]);

export interface ResolvedCoin {
  service: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: string;
  isLaunched: boolean | null;
}

export type CoinResolution =
  | { ok: true; coin: ResolvedCoin }
  | { ok: false; reason: "not_erc20" | "no_total_supply" };

export interface UnruggableProbe {
  exposesInterface: boolean;

  isLaunched: boolean | null;
}

export async function probeUnruggableInterface(
  contractAddress: string,
  deps: { callRpc: typeof defaultCallRpc } = { callRpc: defaultCallRpc },
): Promise<UnruggableProbe> {
  const call = (entrypoint: string) =>
    deps.callRpc((provider) => provider.callContract({ contractAddress, entrypoint, calldata: [] }));

  const [launched, allocation] = await Promise.all([
    call("is_launched").catch(() => null),
    call("get_team_allocation").catch(() => null),
  ]);

  if (launched == null || allocation == null) return { exposesInterface: false, isLaunched: null };
  return { exposesInterface: true, isLaunched: BigInt(launched[0] ?? "0x0") !== 0n };
}

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
    isLaunched?: boolean | null;
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
      isLaunched: params.isLaunched ?? undefined,
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
      isLaunched: params.isLaunched ?? undefined,
    },
  });
}

export async function resolveCoin(
  coinAddress: string,
  isCreatorCoin: boolean,
  deps: { callRpc: typeof defaultCallRpc } = { callRpc: defaultCallRpc },
): Promise<CoinResolution> {
  const call = (entrypoint: string) =>
    deps.callRpc((p) => p.callContract({ contractAddress: coinAddress, entrypoint, calldata: [] }));

  const probe = await probeUnruggableInterface(coinAddress, deps);
  const service = isCreatorCoin
    ? "creator-coin"
    : probe.exposesInterface
      ? "unruggable-erc20"
      : "external-erc20";

  const [nameRes, symbolRes, decRes] = await Promise.all([
    call("name").catch(() => null),
    call("symbol").catch(() => null),
    call("decimals").catch(() => null),
  ]);

  const name = nameRes ? decodeShortStr(nameRes[0] ?? "0x0") : null;
  const symbol = symbolRes ? decodeShortStr(symbolRes[0] ?? "0x0") : null;
  if (!name && !symbol) return { ok: false, reason: "not_erc20" };

  const totalSupply = await readTotalSupply(coinAddress, deps).catch(() => null);
  if (totalSupply == null) return { ok: false, reason: "no_total_supply" };

  return {
    ok: true,
    coin: {
      service,
      name,
      symbol,
      decimals: decRes?.[0] != null ? Number(BigInt(decRes[0])) : 18,
      totalSupply,
      isLaunched: probe.isLaunched,
    },
  };
}
