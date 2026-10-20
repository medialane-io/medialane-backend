import prisma from "../../db/client.js";
import { holdsTokenId } from "../../chainRead/index.js";
import { fetchOrderDetails721, fetchOrderDetails1155 } from "../../mirror/handlers/orderCreated.js";
import type { RemixLinkDeps } from "./remix-offers.rules.js";

export const remixLinkDeps: RemixLinkDeps = {
  collectionStandard: async (contract) => {
    const row = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
      select: { standard: true },
    });
    return row?.standard === "ERC721" || row?.standard === "ERC1155" ? row.standard : null;
  },
  ownsToken: (contract, tokenId, owner, standard) => holdsTokenId("STARKNET", contract, owner, standard, tokenId),
  orderDetails: (orderHash, standard) =>
    standard === "ERC1155" ? fetchOrderDetails1155(orderHash) : fetchOrderDetails721(orderHash),
};
