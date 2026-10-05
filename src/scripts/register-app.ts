import prisma from "../db/client.js";
import { registerApp } from "../apps/register.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const name = option("name");
  const displayName = option("display-name");
  const clientId = option("client-id");
  const days = option("email-confirm-days");
  if (!name || !displayName || !clientId) {
    console.error("Usage: bun run src/scripts/register-app.ts --name APP_NAME --display-name \"App Name\" --client-id <id> [--email-confirm-days N]");
    process.exit(2);
  }
  const result = await registerApp(undefined, {
    name,
    displayName,
    clientId,
    ...(days ? { emailConfirmDays: Number(days) } : {}),
  });
  console.log(`Registered ${result.name} for client ${result.clientId}; app set on ${result.identitiesUpdated} existing identities.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
