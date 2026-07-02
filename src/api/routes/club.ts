import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:club");

const club = new Hono<AppEnv>();

// GET /v1/club/:clubId/info
// The registry's own ClubRecord fields (open/entry fee/member cap) — the
// per-club Collection row only indexes the club_nft contract, not this.
club.get("/:clubId/info", async (c) => {
  const clubId = c.req.param("clubId");

  const info = await prisma.clubInfo.findFirst({
    where: { chain: "STARKNET", clubId },
    orderBy: { createdAt: "desc" },
  });

  if (!info) {
    return c.json({ error: "Club not found" }, 404);
  }

  return c.json({ data: info });
});

// GET /v1/club/:contract/:clubId/membership/:wallet
// :contract is the per-club membership NFT address (each club has its own
// dedicated contract, discovered via NewClubCreated) — that alone determines
// membership; :clubId is carried for URL-shape consistency with the other
// Launchpad status routes, not needed for the lookup itself.
club.get("/:contract/:clubId/membership/:wallet", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));

  const membership = await prisma.tokenBalance.findFirst({
    where: { chain: "STARKNET", contractAddress: contract, owner: wallet, amount: { not: "0" } },
    select: { tokenId: true },
  });

  return c.json({ data: { isMember: membership !== null } });
});

export default club;
