/**
 * Handle OrderCreated events from the Medialane1155 (ERC-1155 marketplace) contract.
 *
 * Unlike ERC-721 orders, all order details are encoded directly in the event data —
 * no extra RPC call to get_order_details() is needed.
 *
 * Event structure (from ABI):
 *   keys[1] = order_hash (felt252)
 *   keys[2] = offerer    (ContractAddress)
 *   data[0] = nft_contract   (ContractAddress)
 *   data[1] = token_id       (felt252)
 *   data[2] = amount         (felt252)   — quantity listed
 *   data[3] = price_per_unit (felt252)   — price per single token in payment_token units
 *   data[4] = payment_token  (ContractAddress)
 */
import type { Chain, Prisma } from "@prisma/client";
import { normalizeAddress } from "../../utils/starknet.js";
import { getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import { MARKETPLACE_1155_CONTRACT } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("handler:orderCreated1155");

export async function handleOrderCreated1155(
  event: RawStarknetEvent,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<string | null> {
  // keys: [selector, order_hash, offerer]
  // data: [nft_contract, token_id, amount, price_per_unit, payment_token]
  const orderHash = normalizeAddress(event.keys[1]);
  const offerer = normalizeAddress(event.keys[2]);
  const nftContract = normalizeAddress(event.data[0]);
  const tokenId = BigInt(event.data[1]).toString();
  const amount = BigInt(event.data[2]).toString();
  const pricePerUnit = BigInt(event.data[3]).toString();
  const paymentToken = normalizeAddress(event.data[4]);

  const blockNumber = typeof event.block_number === "number"
    ? event.block_number
    : Number(event.block_number ?? 0);
  const blockNumberStr = String(blockNumber);
  const txHash = event.transaction_hash ?? "";

  const paymentTokenMeta = getTokenByAddress(paymentToken);
  const priceFormatted = paymentTokenMeta
    ? formatAmount(pricePerUnit, paymentTokenMeta.decimals)
    : pricePerUnit;
  const currencySymbol = paymentTokenMeta?.symbol ?? null;

  await tx.order.upsert({
    where: { chain_orderHash: { chain, orderHash } },
    create: {
      chain,
      orderHash,
      offerer,
      // Offer side: ERC-1155 NFT
      offerItemType: "ERC1155",
      offerToken: nftContract,
      offerIdentifier: tokenId,
      offerStartAmount: amount,
      offerEndAmount: amount,
      // Consideration side: ERC-20 payment (price_per_unit per token)
      considerationItemType: "ERC20",
      considerationToken: paymentToken,
      considerationIdentifier: "0",
      considerationStartAmount: pricePerUnit,
      considerationEndAmount: pricePerUnit,
      considerationRecipient: offerer,
      startTime: BigInt(Math.floor(Date.now() / 1000)),
      endTime: BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600), // placeholder; fetched lazily
      status: "ACTIVE",
      createdBlockNumber: BigInt(blockNumber),
      createdTxHash: txHash,
      nftContract,
      nftTokenId: tokenId,
      priceRaw: pricePerUnit,
      priceFormatted,
      currencySymbol,
      marketplaceContract: normalizeAddress(MARKETPLACE_1155_CONTRACT),
    },
    update: {
      offerer,
      nftContract,
      nftTokenId: tokenId,
      priceRaw: pricePerUnit,
      priceFormatted,
      currencySymbol,
    },
  });

  // Auto-create collection + token records if they don't exist yet
  await tx.collection.upsert({
    where: { chain_contractAddress: { chain, contractAddress: nftContract } },
    create: { chain, contractAddress: nftContract, startBlock: blockNumber, isKnown: false },
    update: {},
  });

  await tx.token.upsert({
    where: { chain_contractAddress_tokenId: { chain, contractAddress: nftContract, tokenId } },
    create: { chain, contractAddress: nftContract, tokenId, metadataStatus: "PENDING" },
    update: {},
  });

  log.debug({ chain, orderHash, nftContract, tokenId, amount, pricePerUnit }, "ERC-1155 order created");
  return nftContract;
}
