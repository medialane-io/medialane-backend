import prisma from "../db/client.js";
import { generateAppSecret, hashAppSecret } from "../utils/appSecret.js";
import { nextSecretHashes } from "../utils/appSecretStore.js";

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const [appId] = args.filter((a) => a !== "--replace");
if (!appId) {
  console.error("Usage: bun run app:secret <APP_ID> [--replace]");
  process.exit(1);
}

try {
  const app = await prisma.app.findUnique({ where: { id: appId }, select: { secretHashes: true } });
  if (!app) throw new Error(`Unknown app: ${appId}`);
  const secret = generateAppSecret();
  const secretHashes = nextSecretHashes(app.secretHashes, hashAppSecret(secret), replace);
  await prisma.app.update({ where: { id: appId }, data: { secretHashes } });
  console.log(`New secret for ${appId} (${secretHashes.length} valid). Store it as MEDIALANE_APP_SECRET; it is not shown again:`);
  console.log(secret);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
