import prisma from "../db/client.js";

export interface ClaimDb {
  app: {
    findMany(args: { where: { clientId: null }; select: { name: true; displayName: true } }): Promise<{ name: string; displayName: string }[]>;
    update(args: { where: { name: string }; data: { clientId: string } }): Promise<unknown>;
  };
  apiCredits: {
    findMany(args: {
      where: { account: { profile: { name: string } } };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
}

export interface ClaimResult {
  linked: string[];
  unlinked: string[];
}

export async function claimFirstPartyClients(db: ClaimDb = prisma as unknown as ClaimDb): Promise<ClaimResult> {
  const result: ClaimResult = { linked: [], unlinked: [] };
  const apps = await db.app.findMany({ where: { clientId: null }, select: { name: true, displayName: true } });
  for (const app of apps) {
    const clients = await db.apiCredits.findMany({
      where: { account: { profile: { name: app.displayName } } },
      select: { id: true },
    });
    if (clients.length !== 1) {
      result.unlinked.push(app.name);
      continue;
    }
    await db.app.update({ where: { name: app.name }, data: { clientId: clients[0]!.id } });
    result.linked.push(app.name);
  }
  return result;
}
