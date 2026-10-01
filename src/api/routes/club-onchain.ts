

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

/**
 * Membership tiers are numbered 1..n with no gaps, and the contract has no count, so find n by doubling
 * until a tier is missing, then halving between the last hit and the miss.
 */
export async function countMemberships(exists: (id: number) => Promise<boolean>): Promise<number> {
  const has = (id: number) => exists(id).catch(() => false);
  if (!(await has(1))) return 0;

  let low = 1;
  let high = 2;
  while (await has(high)) {
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await has(mid)) low = mid;
    else high = mid;
  }
  return low;
}

const club = new Hono<AppEnv>();

club.get("/:contract/count", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const count = await countMemberships(async (id) => {
    const raw = (await col.call("get_membership", [cairo.uint256(id)])) as Parameters<typeof parseMembershipResult>[0];
    return BigInt(raw.max_supply) > 0n;
  });
  return c.json({ data: { count } });
});

club.get("/:contract/:tokenId", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const raw = (await col.call("get_membership", [cairo.uint256(tokenId)])) as Parameters<typeof parseMembershipResult>[0];
  return c.json({ data: parseMembershipResult(raw) });
});

club.get("/:contract/:tokenId/member/:wallet", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const isMember = Boolean(await col.call("is_member_of", [cairo.uint256(tokenId), wallet]));
  return c.json({ data: { isMember } });
});

export default club;
