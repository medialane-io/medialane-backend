import prisma from "../db/client.js";
import { callRpc } from "./starknet.js";

export async function getBlockTimestamp(blockNumber: number): Promise<Date> {
  const cached = await prisma.blockTimestamp.findUnique({
    where: { chain_blockNumber: { chain: "STARKNET", blockNumber: BigInt(blockNumber) } },
  });
  if (cached) return cached.timestamp;

  const block = await callRpc((provider) => provider.getBlockWithTxHashes(blockNumber));
  const timestamp = new Date(block.timestamp * 1000);

  await prisma.blockTimestamp
    .upsert({
      where: { chain_blockNumber: { chain: "STARKNET", blockNumber: BigInt(blockNumber) } },
      create: { chain: "STARKNET", blockNumber: BigInt(blockNumber), timestamp },
      update: {},
    })
    .catch(() => {});

  return timestamp;
}
