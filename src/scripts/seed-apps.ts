import prisma from "../db/client.js";
import { FIRST_PARTY_APPS } from "../apps/registry.js";
import { claimFirstPartyClients } from "../apps/claim.js";

async function main() {
  for (const app of FIRST_PARTY_APPS) {
    await prisma.app.upsert({
      where: { name: app.name },
      update: { displayName: app.displayName, emailConfirmDays: app.emailConfirmDays },
      create: app,
    });
    console.log(`  ${app.name.padEnd(20)} ${app.displayName}`);
  }
  const { linked, unlinked } = await claimFirstPartyClients();
  if (linked.length > 0) console.log(`Linked to a client: ${linked.join(", ")}`);
  if (unlinked.length > 0) console.warn(`No single client found for: ${unlinked.join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
