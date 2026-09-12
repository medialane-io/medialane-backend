
import prisma from "../db/client.js";
import { x402Config, USDC_DECIMALS } from "../config/x402.js";
import { PRICING } from "../../pricing.config.js";

const USD_PER_CREDIT = Number(x402Config.usdcAtomicPerCredit) / 10 ** USDC_DECIMALS;

function usdToCredits(usd: number): number {
  return Math.round(usd / USD_PER_CREDIT);
}

async function main() {
  console.log(`Applying pricing.config.js (1 credit = $${USD_PER_CREDIT.toFixed(2)})…\n`);

  for (const row of PRICING) {
    const chain = row.chain ?? "ALL";
    const service = row.service ?? "ALL";
    const credits = usdToCredits(row.usd);

    await prisma.pricingRule.upsert({
      where: { actionKey_chain_service: { actionKey: row.action, chain, service } },
      update: { credits, label: row.note },
      create: { actionKey: row.action, chain, service, credits, label: row.note },
    });

    const scope = chain === "ALL" && service === "ALL" ? "" : ` [${chain !== "ALL" ? chain : ""}${chain !== "ALL" && service !== "ALL" ? " / " : ""}${service !== "ALL" ? service : ""}]`;
    console.log(`  ${row.action.padEnd(26)} $${row.usd.toFixed(2).padStart(6)}  (${credits} credits)${scope}`);
  }

  const removed = await prisma.pricingRule.deleteMany({
    where: { NOT: PRICING.map((row) => ({ actionKey: row.action, chain: row.chain ?? "ALL", service: row.service ?? "ALL" })) },
  });
  if (removed.count > 0) console.log(`\n  removed ${removed.count} price(s) no longer in the file`);

  console.log(`\n✓ ${PRICING.length} price(s) applied — live within 60s on a running server.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
