import prisma from "../db/client.js";

export async function backfillIdentityApp(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "Identity" i
    SET "app" = a."name"
    FROM "App" a
    WHERE a."clientId" = i."clientId" AND i."app" IS NULL
  `;
}

async function main() {
  const updated = await backfillIdentityApp();
  const remaining = await prisma.identity.count({ where: { app: null } });
  console.log(`Identity.app set on ${updated} identities; ${remaining} still have no app.`);
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
