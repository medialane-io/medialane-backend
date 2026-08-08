// Metered pass-through read for the ip-erc721 genesis contract's audited
// get_full_token_data view (owner/metadataUri/originalCreator/registeredAt).
// This is genesis-specific state the generic Token model doesn't carry
// (originalCreator survives transfers; Token has no such column) — not
// worth a schema change for one contract's view. Does the same on-chain
// call io's use-full-token-data.ts used to make directly (unmetered,
// keyless public RPC), server-side, credited, with a short cache.
import { Hono } from "hono";
import { cairo, Contract, num } from "starknet";
import { IPNftABI } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { publicCache } from "../middleware/publicCache.js";
import type { AppEnv } from "../../types/hono.js";

export interface FullTokenData {
  owner: string;
  metadataUri: string;
  originalCreator: string;
  registeredAt: number;
}

function toAddress(v: unknown): string {
  return "0x" + num.toBigInt(String(v)).toString(16).padStart(64, "0");
}

export function parseFullTokenDataResult(raw: [unknown, unknown, unknown, unknown]): FullTokenData {
  const [ownerRaw, metadataUriRaw, creatorRaw, registeredAtRaw] = raw;
  return {
    owner: toAddress(ownerRaw),
    metadataUri: String(metadataUriRaw ?? ""),
    originalCreator: toAddress(creatorRaw),
    registeredAt: Number(num.toBigInt(String(registeredAtRaw))),
  };
}

const ipnft = new Hono<AppEnv>();

// 30s in-process micro-cache — same pattern as tickets-onchain.ts. Immutable
// except `owner`, which only changes on transfer (infrequent per token).
ipnft.get("/:contract/:tokenId", publicCache(30), async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const col = new Contract({ abi: IPNftABI as never, address: contract, providerOrAccount: createProvider() as never });
  try {
    const raw = (await col.call("get_full_token_data", [cairo.uint256(tokenId)], {
      blockIdentifier: "latest",
    })) as unknown as [unknown, unknown, unknown, unknown];
    return c.json({ data: parseFullTokenDataResult(raw) });
  } catch {
    // Legacy / external collections that don't implement get_full_token_data.
    return c.json({ data: null });
  }
});

export default ipnft;
