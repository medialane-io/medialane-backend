import prisma from "../db/client.js";

type SharedRow = { contractAddress: string; collectionDescription: string | null; sharedText: string; tokens: number };
type Plan = { contractAddress: string; setCollectionDescription: string | null; clearTokens: number };

const CHAIN = "STARKNET" as const;

/** What to do for a collection whose tokens all carry the same description. */
export function planSharedDescription(row: SharedRow): Plan | null {
  const own = row.collectionDescription?.trim() ?? "";
  if (own && own !== row.sharedText.trim()) return null;
  return {
    contractAddress: row.contractAddress,
    setCollectionDescription: own ? null : row.sharedText,
    clearTokens: row.tokens,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "Storing shared descriptions once" : "Dry run: nothing is written");

  const rows = await prisma.$queryRaw<SharedRow[]>`
    SELECT t."contractAddress", c.description AS "collectionDescription",
           MIN(t.description) AS "sharedText", COUNT(*)::int AS tokens
    FROM "Token" t
    JOIN "Collection" c ON c.chain = t.chain AND c."contractAddress" = t."contractAddress"
    WHERE t.chain = ${CHAIN}::"Chain" AND t.description IS NOT NULL
    GROUP BY t."contractAddress", c.description
    HAVING COUNT(*) > 1 AND COUNT(DISTINCT btrim(t.description)) = 1
  `;

  let cleared = 0;
  try {
    for (const row of rows) {
      const plan = planSharedDescription(row);
      if (!plan) continue;
      console.log(JSON.stringify(plan));
      cleared += plan.clearTokens;
      if (!apply) continue;
      await prisma.$transaction(async (tx) => {
        if (plan.setCollectionDescription) {
          await tx.collection.update({
            where: { chain_contractAddress: { chain: CHAIN, contractAddress: plan.contractAddress } },
            data: { description: plan.setCollectionDescription },
          });
        }
        await tx.$executeRaw`
          UPDATE "Token" SET description = NULL
          WHERE chain = ${CHAIN}::"Chain" AND "contractAddress" = ${plan.contractAddress}
            AND btrim(description) = btrim(${row.sharedText})
        `;
      }, { timeout: 120000 });
    }
  } catch (err) {
    console.error("Stopped:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify({ collections: rows.length, tokenCopiesRemoved: cleared }));
    await prisma.$disconnect();
  }
}

if (import.meta.main) await main();
