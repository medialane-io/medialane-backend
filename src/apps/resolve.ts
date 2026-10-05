import prisma from "../db/client.js";

export interface AppLookupDb {
  app: {
    findUnique(args: { where: { clientId: string }; select: { name: true } }): Promise<{ name: string } | null>;
  };
}

export interface ClientLookupDb {
  app: {
    findUnique(args: { where: { name: string }; select: { clientId: true } }): Promise<{ clientId: string | null } | null>;
  };
}

export async function appNameForClient(
  clientId: string,
  db: AppLookupDb = prisma as unknown as AppLookupDb,
): Promise<string | null> {
  const app = await db.app.findUnique({ where: { clientId }, select: { name: true } });
  return app?.name ?? null;
}

export async function clientIdForApp(
  name: string,
  db: ClientLookupDb = prisma as unknown as ClientLookupDb,
): Promise<string | null> {
  const app = await db.app.findUnique({ where: { name }, select: { clientId: true } });
  return app?.clientId ?? null;
}
