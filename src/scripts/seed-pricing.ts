/**
 * Seed default x402 credit pricing (PricingRule). Safe to re-run — upsert.
 *
 * Seeds the chain-agnostic, service-agnostic ("ALL"/"ALL") default for every
 * actionKey, matching today's live flat pricing (1 credit for reads, 5 for
 * every intent) so running this the first time is a pricing no-op. Retune
 * via the admin pricing endpoints from there — this file is the starting
 * point, not the source of ongoing truth.
 *
 * Usage: bun run src/scripts/seed-pricing.ts
 */

import prisma from "../db/client.js";

const DEFAULT_RULES: ReadonlyArray<{ actionKey: string; credits: number; label: string }> = [
  { actionKey: "read", credits: 1, label: "Any read/query request" },
  { actionKey: "intent:mint", credits: 5, label: "Mint an asset" },
  { actionKey: "intent:create-collection", credits: 5, label: "Deploy a collection" },
  { actionKey: "intent:create-tier", credits: 5, label: "Create a ticket type / membership tier" },
  { actionKey: "intent:listing", credits: 5, label: "List an asset for sale" },
  { actionKey: "intent:offer", credits: 5, label: "Make an offer" },
  { actionKey: "intent:cancel", credits: 5, label: "Cancel an order" },
  { actionKey: "intent:fulfill", credits: 5, label: "Fulfill an order (buy)" },
  { actionKey: "intent:counter-offer", credits: 5, label: "Counter an offer" },
  { actionKey: "intent:checkout", credits: 5, label: "Checkout" },
];

async function main() {
  console.log("Seeding default pricing (chain=ALL, service=ALL)…");

  for (const r of DEFAULT_RULES) {
    await prisma.pricingRule.upsert({
      where: { actionKey_chain_service: { actionKey: r.actionKey, chain: "ALL", service: "ALL" } },
      update: { credits: r.credits, label: r.label },
      create: { actionKey: r.actionKey, chain: "ALL", service: "ALL", credits: r.credits, label: r.label },
    });
  }
  console.log(`  ✓ ${DEFAULT_RULES.length} default pricing rules`);
  console.log("Done. Retune with PATCH /admin/pricing/:actionKey (optionally ?chain=&service=).");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
