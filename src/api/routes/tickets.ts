import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:tickets");

const tickets = new Hono<AppEnv>();

// GET /v1/tickets/:contract/collections
// Lists the inner ticket collections (event/tier batches) inside one
// deployed IPTicketCollection contract. One creator's contract can hold
// several — this is the read the Launchpad detail/mint page needs.
tickets.get("/:contract/collections", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));

  const collections = await prisma.ticketCollectionInfo.findMany({
    where: { chain: "STARKNET", contractAddress: contract },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ data: collections });
});

// GET /v1/tickets/:contract/:collectionId/status/:wallet
// Mirrors has_valid_ticket/get_active_ticket_balance on IPTicketCollection —
// DB-backed (Token.redeemed + TicketCollectionInfo.expiration + TokenBalance
// ownership), same pattern as /v1/pop/eligibility.
tickets.get("/:contract/:collectionId/status/:wallet", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const collectionId = c.req.param("collectionId");
  const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));

  const [ticketCollection, unredeemedTokens] = await Promise.all([
    prisma.ticketCollectionInfo.findUnique({
      where: {
        chain_contractAddress_ticketCollectionId: {
          chain: "STARKNET",
          contractAddress: contract,
          ticketCollectionId: collectionId,
        },
      },
      select: { expiration: true },
    }),
    prisma.token.findMany({
      where: { chain: "STARKNET", contractAddress: contract, ticketCollectionId: collectionId, redeemed: false },
      select: { tokenId: true },
    }),
  ]);

  if (!ticketCollection) {
    return c.json({ data: { hasValidTicket: false, activeBalance: 0 } });
  }

  const activeBalance = await prisma.tokenBalance.count({
    where: {
      chain: "STARKNET",
      contractAddress: contract,
      owner: wallet,
      amount: { not: "0" },
      tokenId: { in: unredeemedTokens.map((t) => t.tokenId) },
    },
  });

  const now = BigInt(Math.floor(Date.now() / 1000));
  const hasValidTicket = activeBalance > 0 && ticketCollection.expiration > now;

  return c.json({ data: { hasValidTicket, activeBalance } });
});

export default tickets;
