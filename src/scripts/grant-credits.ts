import { userInfo } from "os";
import prisma from "../db/client.js";
import { grantToAccount } from "../payments/grants.js";

const [publicId, creditsArg, ...reasonParts] = process.argv.slice(2);
if (!publicId || !creditsArg || reasonParts.length === 0) {
  console.error('Usage: bun run credits:grant <accountPublicId> <credits> "<reason>"');
  process.exit(1);
}

try {
  const operator = process.env.GRANTED_BY ?? userInfo().username;
  const result = await grantToAccount(publicId, Number(creditsArg), reasonParts.join(" "), operator);
  console.log(`Granted ${creditsArg} credits to ${publicId}. Balance: ${result.creditBalance}.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
