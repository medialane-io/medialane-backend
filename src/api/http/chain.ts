import type { Chain } from "@prisma/client";
import { createMiddleware } from "hono/factory";
import { ENABLED_CHAINS } from "../../config/chains.js";
import type { AppEnv } from "../../types/hono.js";
import { parseChainFilter, parseSingleChain, type ChainFilter } from "../utils/chainFilter.js";
import { badRequest } from "./errors.js";

export type ChainEnv = AppEnv & { Variables: { chain: Chain } };

export type ChainFilterEnv = AppEnv & { Variables: { chainFilter: ChainFilter } };

export const chainScope = (enabled: readonly Chain[] = ENABLED_CHAINS) =>
  createMiddleware<ChainEnv>(async (c, next) => {
    const chain = parseSingleChain(c.req.query("chain"), enabled);
    if (!chain) throw badRequest("Invalid chain");
    c.set("chain", chain);
    await next();
  });

export const chainFilterScope = (enabled: readonly Chain[] = ENABLED_CHAINS) =>
  createMiddleware<ChainFilterEnv>(async (c, next) => {
    const chainFilter = parseChainFilter(c.req.query("chain"), enabled);
    if (!chainFilter) throw badRequest("Invalid chain");
    c.set("chainFilter", chainFilter);
    await next();
  });
