

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

    return c.json({ data: null });
  }
});

export default ipnft;
