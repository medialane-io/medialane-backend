import { Hono } from "hono";
import { Prisma, type Chain } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { chainScope } from "../http/chain.js";
import { pageQuery } from "@medialane/sdk/contract";
import { validated } from "../http/validate.js";

export interface AccountRow {
  address: string;
  collections: number;
  assets: number;
}

export interface AccountsDeps {
  list: (chain: Chain, hex: string, limit: number, skip: number) => Promise<{ rows: AccountRow[]; total: number }>;
}

export function createAccountsRoutes(deps: AccountsDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", chainScope(), validated("query", pageQuery({ maxLimit: 50 })), async (c) => {
    const chain = c.get("chain");
    const { page, limit, skip } = c.req.valid("query");
    const hex = (c.req.query("search") ?? "").trim().toLowerCase().replace(/^0x/, "");
    if (hex && !/^[0-9a-f]+$/.test(hex)) return c.json({ data: [], meta: { page, limit, total: 0 } });

    const { rows, total } = await deps.list(chain, hex, limit, skip);
    return c.json({ data: rows, meta: { page, limit, total } });
  });

  return app;
}

type RawAccountRow = { address: string; collections: number; assets: number; total: number };

const productionDeps: AccountsDeps = {
  async list(chain, hex, limit, skip) {
    const match = hex ? Prisma.sql`AND a.address LIKE ${`%${hex}%`}` : Prisma.empty;
    const raw = await prisma.$queryRaw<RawAccountRow[]>`
      WITH held AS (
        SELECT owner AS address, COUNT(*)::int AS collections, 0 AS assets
        FROM "Collection"
        WHERE chain = ${chain}::"Chain" AND owner IS NOT NULL AND "isHidden" = false AND "deletedAt" IS NULL
        GROUP BY owner
        UNION ALL
        SELECT owner AS address, 0 AS collections, COUNT(*)::int AS assets
        FROM "TokenBalance"
        WHERE chain = ${chain}::"Chain" AND amount <> '0'
        GROUP BY owner
      ),
      a AS (
        SELECT address, SUM(collections)::int AS collections, SUM(assets)::int AS assets
        FROM held
        GROUP BY address
      )
      SELECT a.address, a.collections, a.assets, COUNT(*) OVER ()::int AS total
      FROM a
      WHERE NOT EXISTS (
        SELECT 1 FROM "HiddenCreator" h WHERE h.chain = ${chain}::"Chain" AND h.address = a.address
      )
      ${match}
      ORDER BY a.collections DESC, a.assets DESC, a.address ASC
      LIMIT ${limit} OFFSET ${skip}
    `;
    return {
      rows: raw.map(({ address, collections, assets }) => ({ address, collections, assets })),
      total: raw[0]?.total ?? 0,
    };
  },
};

export const accountsRoutes = createAccountsRoutes(productionDeps);
