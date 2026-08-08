// Metered pass-through reads for ip-club tier state (maxSupply/minted/
// validity window/royalty) and per-wallet membership checks. Genuinely
// mutable (minted/membership change on every mint) and low-cardinality/
// low-traffic — not worth a full mirror-indexed pipeline. Does the same
// on-chain get_membership/is_member_of call io's use-club.ts used to make
// directly (unmetered), server-side, credited, with a short cache.
import { Hono } from "hono";
import { cairo, Contract } from "starknet";
import { IPClubCollectionABI } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { publicCache } from "../middleware/publicCache.js";
import type { AppEnv } from "../../types/hono.js";

export interface MembershipOnchain {
  maxSupply: string;
  minted: string;
  startTime: number | null;
  endTime: number | null;
  royaltyBps: number;
}

function parseOption(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && typeof (v as { unwrap?: unknown }).unwrap === "function") {
    const inner = (v as { unwrap: () => unknown }).unwrap();
    return inner != null ? Number(inner) : null;
  }
  if (typeof v === "bigint" || typeof v === "number") return Number(v);
  return null;
}

export function parseMembershipResult(raw: {
  max_supply: bigint | number | string;
  minted: bigint | number | string;
  start_time: unknown;
  end_time: unknown;
  royalty_bps: bigint | number | string;
}): MembershipOnchain {
  return {
    maxSupply: raw.max_supply.toString(),
    minted: raw.minted.toString(),
    startTime: parseOption(raw.start_time),
    endTime: parseOption(raw.end_time),
    royaltyBps: Number(raw.royalty_bps),
  };
}

const club = new Hono<AppEnv>();

// 30s in-process micro-cache — same pattern as tickets-onchain.ts. Membership
// tiers change rarely (only on mint / create_membership).
club.get("/:contract/:tokenId", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const raw = (await col.call("get_membership", [cairo.uint256(tokenId)])) as Parameters<typeof parseMembershipResult>[0];
  return c.json({ data: parseMembershipResult(raw) });
});

// Per-wallet membership check — balance + validity window, not cached (identity-scoped).
club.get("/:contract/:tokenId/member/:wallet", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const isMember = Boolean(await col.call("is_member_of", [cairo.uint256(tokenId), wallet]));
  return c.json({ data: { isMember } });
});

export default club;
