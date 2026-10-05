import prisma from "../db/client.js";

export interface RegisterAppDb {
  app: {
    findUnique(args: { where: { name?: string; clientId?: string }; select: { name: true } }): Promise<{ name: string } | null>;
    create(args: {
      data: { name: string; displayName: string; clientId: string; emailConfirmDays: number | null };
    }): Promise<unknown>;
  };
  apiClient: { findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null> };
  identity: {
    updateMany(args: { where: { clientId: string; app: null }; data: { app: string } }): Promise<{ count: number }>;
  };
}

export interface RegisterAppInput {
  name: string;
  displayName: string;
  clientId: string;
  emailConfirmDays?: number;
}

export interface RegisterAppResult {
  name: string;
  clientId: string;
  identitiesUpdated: number;
}

export async function registerApp(
  db: RegisterAppDb = prisma as unknown as RegisterAppDb,
  input: RegisterAppInput,
): Promise<RegisterAppResult> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(input.name)) throw new Error("The app name must be upper case letters, digits and underscores");
  if (!input.displayName.trim()) throw new Error("The display name must not be empty");
  if (await db.app.findUnique({ where: { name: input.name }, select: { name: true } })) {
    throw new Error(`${input.name} is already registered`);
  }
  if (!(await db.apiClient.findUnique({ where: { id: input.clientId }, select: { id: true } }))) {
    throw new Error(`There is no client ${input.clientId}`);
  }
  const bound = await db.app.findUnique({ where: { clientId: input.clientId }, select: { name: true } });
  if (bound) throw new Error(`That client is already bound to ${bound.name}`);

  await db.app.create({
    data: {
      name: input.name,
      displayName: input.displayName.trim(),
      clientId: input.clientId,
      emailConfirmDays: input.emailConfirmDays ?? null,
    },
  });
  const { count } = await db.identity.updateMany({
    where: { clientId: input.clientId, app: null },
    data: { app: input.name },
  });
  return { name: input.name, clientId: input.clientId, identitiesUpdated: count };
}
