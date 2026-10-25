import { Hono } from "hono";
import { cairo, Contract } from "starknet";
import { IPClubCollectionABI } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { parseTierResult } from "../utils/tierOnchain.js";
import type { AppEnv } from "../../types/hono.js";

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

club.get("/:contract/count", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const count = await countMemberships(async (id) => {
    const raw = (await col.call("get_membership", [cairo.uint256(id)])) as Parameters<typeof parseTierResult>[0];
    return BigInt(raw.max_supply) > 0n;
  });
  return c.json({ data: { count } });
});

club.get("/:contract/:tokenId", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const col = new Contract({ abi: IPClubCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const raw = (await col.call("get_membership", [cairo.uint256(tokenId)])) as Parameters<typeof parseTierResult>[0];
  return c.json({ data: parseTierResult(raw) });
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
