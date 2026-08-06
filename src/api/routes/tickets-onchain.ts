// Metered pass-through reads for ip-tickets tier state (maxSupply/minted/
// validity window/royalty). This is genuinely mutable (minted changes on
// every mint) and low-cardinality/low-traffic — not worth a full
// mirror-indexed pipeline. Does the same on-chain get_ticket/ticket_count
// call the dapp's use-tickets.ts used to make directly (unmetered),
// server-side, credited, with a short cache.
import { Hono } from "hono";
import { cairo, Contract } from "starknet";
import { IPTicketCollectionABI } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { publicCache } from "../middleware/publicCache.js";
import type { AppEnv } from "../../types/hono.js";

export interface TicketOnchain {
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

export function parseTicketResult(raw: {
  max_supply: bigint | number | string;
  minted: bigint | number | string;
  start_time: unknown;
  end_time: unknown;
  royalty_bps: bigint | number | string;
}): TicketOnchain {
  return {
    maxSupply: raw.max_supply.toString(),
    minted: raw.minted.toString(),
    startTime: parseOption(raw.start_time),
    endTime: parseOption(raw.end_time),
    royaltyBps: Number(raw.royalty_bps),
  };
}

const tickets = new Hono<AppEnv>();

// 30s in-process micro-cache — same pattern as stats.ts. Ticket tiers change
// rarely (only on mint / create_ticket), a short cache absorbs repeat reads
// of the same tier without adding staleness that matters for display.
tickets.get("/:contract/count", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const col = new Contract({ abi: IPTicketCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const count = Number(await col.call("ticket_count", []));
  return c.json({ data: { count } });
});

tickets.get("/:contract/:tokenId", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const col = new Contract({ abi: IPTicketCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const raw = (await col.call("get_ticket", [cairo.uint256(tokenId)])) as Parameters<typeof parseTicketResult>[0];
  return c.json({ data: parseTicketResult(raw) });
});

export default tickets;
