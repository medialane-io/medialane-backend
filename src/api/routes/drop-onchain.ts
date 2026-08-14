

import { Hono } from "hono";
import { Contract } from "starknet";
import { DropCollectionABI } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { publicCache } from "../middleware/publicCache.js";
import type { AppEnv } from "../../types/hono.js";

export interface DropOnchainState {
  conditions: {
    maxSupply: string;
    price: string;
    paymentToken: string;
    startTime: number;
    endTime: number;
    maxPerWallet: string;
  };
  totalMinted: number;
  maxSupply: number;
  allowlistEnabled: boolean;
  paused: boolean;
}

function toBool(v: boolean | bigint): boolean {
  return typeof v === "bigint" ? v !== 0n : v;
}

export function parseDropOnchainState(raw: {
  cond: { start_time: bigint; end_time: bigint; price: bigint; payment_token: bigint | string; max_quantity_per_wallet: bigint };
  minted: bigint;
  max: bigint;
  allow: boolean | bigint;
  paused: boolean | bigint;
}): DropOnchainState {
  const paymentToken =
    typeof raw.cond.payment_token === "bigint" ? "0x" + raw.cond.payment_token.toString(16) : String(raw.cond.payment_token);
  return {
    conditions: {
      maxSupply: BigInt(raw.max).toString(),
      price: BigInt(raw.cond.price).toString(),
      paymentToken,
      startTime: Number(raw.cond.start_time),
      endTime: Number(raw.cond.end_time),
      maxPerWallet: BigInt(raw.cond.max_quantity_per_wallet).toString(),
    },
    totalMinted: Number(raw.minted),
    maxSupply: Number(raw.max),
    allowlistEnabled: toBool(raw.allow),
    paused: toBool(raw.paused),
  };
}

const drop = new Hono<AppEnv>();

drop.get("/:contract/state", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const col = new Contract({ abi: DropCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const [cond, minted, max, allow, paused] = await Promise.all([
    col.call("get_claim_conditions", []) as Promise<{
      start_time: bigint; end_time: bigint; price: bigint; payment_token: bigint | string; max_quantity_per_wallet: bigint;
    }>,
    col.call("total_minted", []) as Promise<bigint>,
    col.call("get_max_supply", []) as Promise<bigint>,
    col.call("is_allowlist_enabled", []) as Promise<boolean | bigint>,
    col.call("is_paused", []) as Promise<boolean | bigint>,
  ]);
  return c.json({ data: parseDropOnchainState({ cond, minted, max, allow, paused }) });
});

export default drop;
