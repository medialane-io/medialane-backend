import prisma from "../db/client.js";

function connectionLabel(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "unknown (DATABASE_URL unset)";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "unknown (DATABASE_URL unparseable)";
  }
}

async function preflightSchema() {
  const required = ["Account", "Wallet", "Identity", "AccountProfile"];
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${required}::text[])
  `;
  const present = new Set(rows.map((r) => r.table_name));
  const missing = required.filter((t) => !present.has(t));
  if (missing.length > 0) {
    console.error(
      `Schema not ready on ${connectionLabel()}:\n` +
        `  missing tables: ${missing.join(", ")}\n` +
        `  run \`prisma migrate deploy\` first (or \`bun run prod:migrate-status\` to inspect).`
    );
    process.exit(2);
  }
}

async function main() {
  await preflightSchema();

  const [
    accounts,
    wallets,
    identities,
    profiles,
    orphanWallets,
    multiAccountWallets,
    scoresLinked,
    scoresTotal,
    badgesLinked,
    badgesTotal,
  ] = await Promise.all([
    prisma.account.count(),
    prisma.wallet.count(),
    prisma.identity.count(),
    prisma.accountProfile.count(),
    prisma.$queryRaw<
      { c: bigint }[]
    >`SELECT COUNT(*) AS c FROM "Wallet" w WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a.id = w."accountId")`,
    prisma.$queryRaw<
      { c: bigint }[]
    >`SELECT COUNT(*) AS c FROM (SELECT "chain","address",COUNT(DISTINCT "accountId") d FROM "Wallet" GROUP BY 1,2 HAVING COUNT(DISTINCT "accountId") > 1) s`,
    prisma.userScore.count({ where: { accountId: { not: null } } }),
    prisma.userScore.count(),
    prisma.userBadge.count({ where: { accountId: { not: null } } }),
    prisma.userBadge.count(),
  ]);

  const report = {
    connection: connectionLabel(),
    accounts,
    wallets,
    identities,
    profiles,
    invariants: {
      orphan_wallets_no_account: Number(orphanWallets[0]?.c ?? 0n),
      wallets_with_multiple_accounts: Number(multiAccountWallets[0]?.c ?? 0n),
    },
    reputation: {
      user_scores_linked: scoresLinked,
      user_scores_total: scoresTotal,
      user_badges_linked: badgesLinked,
      user_badges_total: badgesTotal,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  const failed: string[] = [];
  if (report.invariants.orphan_wallets_no_account > 0) failed.push("orphan wallets exist");
  if (report.invariants.wallets_with_multiple_accounts > 0)
    failed.push("same wallet on multiple accounts");

  if (failed.length > 0) {
    console.error("INVARIANT FAILURES:\n" + failed.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
  console.log("✓ all invariants pass");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
