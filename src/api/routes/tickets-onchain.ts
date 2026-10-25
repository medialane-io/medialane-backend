

import { Hono } from "hono";
import { cairo, Contract } from "starknet";
import { IPTicketCollectionABI } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { parseTierResult } from "../utils/tierOnchain.js";
import type { AppEnv } from "../../types/hono.js";

const tickets = new Hono<AppEnv>();

tickets.get("/:contract/count", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const col = new Contract({ abi: IPTicketCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const count = Number(await col.call("ticket_count", []));
  return c.json({ data: { count } });
});

tickets.get("/:contract/:tokenId", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const tokenId = c.req.param("tokenId");
  const col = new Contract({ abi: IPTicketCollectionABI as never, address: contract, providerOrAccount: createProvider() as never });
  const raw = (await col.call("get_ticket", [cairo.uint256(tokenId)])) as Parameters<typeof parseTierResult>[0];
  return c.json({ data: parseTierResult(raw) });
});

export default tickets;
