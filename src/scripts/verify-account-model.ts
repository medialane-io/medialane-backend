import prisma from "../db/client.js";

async function main() {
  const [
    accounts,
    wallets,
    identities,
    profiles,
    users,
    creatorProfiles,
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
    prisma.user.count(),
    prisma.creatorProfile.count(),
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
    accounts,
    wallets,
    identities,
    profiles,
    legacy: { users, creatorProfiles },
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
  if (accounts < users) failed.push(`accounts (${accounts}) < users (${users})`);
  if (wallets < users) failed.push(`wallets (${wallets}) < users (${users})`);
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
