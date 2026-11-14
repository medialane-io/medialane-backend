import { Hono } from "hono";
import { Prisma, type Chain } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { chainScope } from "../http/chain.js";
import { pageQuery } from "@medialane/sdk/contract";
import { validated } from "../http/validate.js";
import { SLUG_TO_IP_TYPE } from "../utils/ipTypes.js";

export interface AccountRow {
  address: string;
  image: string | null;
  ipType: string | null;
}

export interface AccountsQuery {
  hex: string;
  ipType: string;
}

export interface AccountsDeps {
  list: (chain: Chain, query: AccountsQuery, limit: number, skip: number) => Promise<{ rows: AccountRow[]; total: number }>;
}

export function createAccountsRoutes(deps: AccountsDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", chainScope(), validated("query", pageQuery({ maxLimit: 50 })), async (c) => {
    const chain = c.get("chain");
    const { page, limit, skip } = c.req.valid("query");
    const hex = (c.req.query("search") ?? "").trim().toLowerCase().replace(/^0x/, "");
    const ipType = (c.req.query("ipType") ?? "").trim().toLowerCase();
    if (hex && !/^[0-9a-f]+$/.test(hex)) return c.json({ data: [], meta: { page, limit, total: 0 } });

    const { rows, total } = await deps.list(chain, { hex, ipType }, limit, skip);
    return c.json({ data: rows, meta: { page, limit, total } });
  });

  return app;
}

type RawAccountRow = { address: string; image: string | null; ipType: string | null; total: number };

function ipTypeCondition(slug: string): Prisma.Sql | null {
  if (slug === "nft") return Prisma.sql`(t."ipType" = 'NFT' OR t."ipType" IS NULL)`;
  const canonical = SLUG_TO_IP_TYPE[slug];
  return canonical ? Prisma.sql`t."ipType" = ${canonical}` : null;
}

const productionDeps: AccountsDeps = {
  async list(chain, { hex, ipType }, limit, skip) {
    const type = ipTypeCondition(ipType);
    const join = Prisma.sql`JOIN "Token" t ON t.chain = b.chain AND t."contractAddress" = b."contractAddress" AND t."tokenId" = b."tokenId"`;
    const activity = type
      ? Prisma.sql`
          SELECT b.owner AS address, b."updatedAt" AS at
          FROM "TokenBalance" b ${join}
          WHERE b.chain = ${chain}::"Chain" AND b.amount <> '0' AND t."isHidden" = false AND ${type}`
      : Prisma.sql`
          SELECT b.owner AS address, b."updatedAt" AS at
          FROM "TokenBalance" b
          WHERE b.chain = ${chain}::"Chain" AND b.amount <> '0'
          UNION ALL
          SELECT owner AS address, "createdAt" AS at
          FROM "Collection"
          WHERE chain = ${chain}::"Chain" AND owner IS NOT NULL AND "isHidden" = false AND "deletedAt" IS NULL`;
    const match = hex ? Prisma.sql`AND a.address LIKE ${`%${hex}%`}` : Prisma.empty;
    const featuredType = type ? Prisma.sql`AND ${type}` : Prisma.empty;

    const raw = await prisma.$queryRaw<RawAccountRow[]>`
      WITH activity AS (${activity}),
      page AS (
        SELECT a.address, MAX(a.at) AS at, COUNT(*) OVER ()::int AS total
        FROM activity a
        WHERE NOT EXISTS (
          SELECT 1 FROM "HiddenCreator" h WHERE h.chain = ${chain}::"Chain" AND h.address = a.address
        )
        ${match}
        GROUP BY a.address
        ORDER BY MAX(a.at) DESC, a.address ASC
        LIMIT ${limit} OFFSET ${skip}
      )
      SELECT p.address, f.image, f."ipType", p.total
      FROM page p
      LEFT JOIN LATERAL (
        SELECT t.image, t."ipType"
        FROM "TokenBalance" b ${join}
        WHERE b.chain = ${chain}::"Chain" AND b.owner = p.address AND b.amount <> '0'
          AND t."isHidden" = false AND t.image IS NOT NULL ${featuredType}
        ORDER BY b."updatedAt" DESC
        LIMIT 1
      ) f ON true
      ORDER BY p.at DESC, p.address ASC
    `;
    return {
      rows: raw.map(({ address, image, ipType: featuredIpType }) => ({ address, image, ipType: featuredIpType })),
      total: raw[0]?.total ?? 0,
    };
  },
};

export const accountsRoutes = createAccountsRoutes(productionDeps);
