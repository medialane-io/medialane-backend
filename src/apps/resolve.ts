import prisma from "../db/client.js";

export interface AppLookupDb {
  app: {
    findUnique(args: { where: { clientId: string }; select: { name: true } }): Promise<{ name: string } | null>;
  };
}

export async function appNameForClient(
  clientId: string,
  db: AppLookupDb = prisma as unknown as AppLookupDb,
): Promise<string | null> {
  const app = await db.app.findUnique({ where: { clientId }, select: { name: true } });
  return app?.name ?? null;
}
