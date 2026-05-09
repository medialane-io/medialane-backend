import type { Chain, Prisma } from "@prisma/client";
import { getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:orderFill");

type RecordOrderFillInput = {
  chain: Chain;
  orderHash: string;
  fulfiller: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  quantity?: string;
  remainingAmount?: string | null;
};

function multiplyRawAmount(priceRaw: string | null, quantity: string): string | null {
  if (!priceRaw) return null;
  try {
    return (BigInt(priceRaw) * BigInt(quantity)).toString();
  } catch {
    return priceRaw;
  }
}

export async function recordOrderFill(
  input: RecordOrderFillInput,
  tx: Prisma.TransactionClient
): Promise<void> {
  const order = await tx.order.findUnique({
    where: { chain_orderHash: { chain: input.chain, orderHash: input.orderHash } },
    select: {
      offerItemType: true,
      offerToken: true,
      considerationToken: true,
      priceRaw: true,
      currencySymbol: true,
      nftContract: true,
      nftTokenId: true,
    },
  });

  if (!order) {
    log.warn(
      { chain: input.chain, orderHash: input.orderHash, txHash: input.txHash },
      "Order fill skipped because order row is missing"
    );
    return;
  }

  const quantity = input.quantity ?? "1";
  const priceRaw = multiplyRawAmount(order.priceRaw, quantity);
  const currencyToken = order.offerItemType === "ERC20"
    ? order.offerToken
    : order.considerationToken;
  const tokenMeta = currencyToken ? getTokenByAddress(currencyToken) : null;
  const priceFormatted = priceRaw && tokenMeta
    ? formatAmount(priceRaw, tokenMeta.decimals)
    : priceRaw;

  await tx.orderFill.upsert({
    where: {
      chain_orderHash_txHash_logIndex: {
        chain: input.chain,
        orderHash: input.orderHash,
        txHash: input.txHash,
        logIndex: input.logIndex,
      },
    },
    create: {
      chain: input.chain,
      orderHash: input.orderHash,
      fulfiller: input.fulfiller,
      quantity,
      remainingAmount: input.remainingAmount ?? null,
      priceRaw,
      priceFormatted,
      currencySymbol: tokenMeta?.symbol ?? order.currencySymbol,
      currencyToken,
      nftContract: order.nftContract,
      nftTokenId: order.nftTokenId,
      txHash: input.txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
    },
    update: {
      fulfiller: input.fulfiller,
      quantity,
      remainingAmount: input.remainingAmount ?? null,
      priceRaw,
      priceFormatted,
      currencySymbol: tokenMeta?.symbol ?? order.currencySymbol,
      currencyToken,
      nftContract: order.nftContract,
      nftTokenId: order.nftTokenId,
      blockNumber: input.blockNumber,
    },
  });
}
