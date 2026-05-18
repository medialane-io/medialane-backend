import prisma from "../db/client.js";
import { generateAccountPublicId } from "../utils/account.js";
import { normalizeAddress } from "../utils/starknet.js";
import { createLogger } from "../utils/logger.js";
import type { IdentityProvider, WalletType, AppSource } from "@prisma/client";

const log = createLogger("backfill-accounts");

/**
 * Migrates legacy User + CreatorProfile rows into the new Account model.
 *
 * 1. Each User row → 1 Account (type PERSON) + 1 Wallet + 1 Identity + empty AccountProfile.
 * 2. Each CreatorProfile row (incl. orphans with no matching User) → ensures an Account exists,
 *    copies profile fields into AccountProfile, marks Account with CREATOR role.
 * 3. UserScore / UserBadge / PointEvent rows get accountId populated where the wallet resolves;
 *    unresolved rows stay null (the ~449 activity-only addresses are deferred to a future script).
 *
 * Idempotent: re-running skips already-migrated wallets via the (chain, address) unique constraint.
 * Use --dry-run to print counts without writing.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  log.info({ dryRun }, "starting backfill");

  const users = await prisma.user.findMany();
  const creatorProfiles = await prisma.creatorProfile.findMany();
  log.info({ users: users.length, creatorProfiles: creatorProfiles.length }, "source counts");

  let accountsCreated = 0;
  let walletsCreated = 0;
  let identitiesCreated = 0;
  let profilesUpdated = 0;
  let orphansProvisioned = 0;
  const walletAddressToAccountId = new Map<string, string>();

  // ─── Phase 1: User → Account + Wallet + Identity + empty AccountProfile ─────
  for (const u of users) {
    const address = normalizeAddress(u.walletAddress);
    const existing = await prisma.wallet.findUnique({
      where: { chain_address: { chain: u.chain, address } },
      select: { accountId: true },
    });
    if (existing) {
      walletAddressToAccountId.set(address, existing.accountId);
      continue;
    }

    const provider = mapAppSourceToProvider(u.walletType, u.appSource);
    const providerUserId =
      provider === "WALLET"
        ? `wallet:${u.chain}:${address}`
        : `${u.appSource}:${address}`;

    if (dryRun) {
      log.info(
        { address, walletType: u.walletType, provider, appSource: u.appSource },
        "DRY would create Account+Wallet+Identity",
      );
      accountsCreated++;
      walletsCreated++;
      identitiesCreated++;
      continue;
    }

    const account = await prisma.$transaction(async (tx) => {
      const a = await tx.account.create({
        data: {
          publicId: generateAccountPublicId(),
          type: "PERSON",
          roles: [],
          createdAt: u.createdAt,
        },
      });
      await tx.wallet.create({
        data: {
          accountId: a.id,
          chain: u.chain,
          address,
          walletType: u.walletType as WalletType,
          isPrimary: true,
          linkedAt: u.createdAt,
        },
      });
      await tx.identity.create({
        data: {
          accountId: a.id,
          provider,
          providerUserId,
          appSource: u.appSource as AppSource,
          createdAt: u.createdAt,
        },
      });
      await tx.accountProfile.create({ data: { accountId: a.id } });
      return a;
    });
    walletAddressToAccountId.set(address, account.id);
    accountsCreated++;
    walletsCreated++;
    identitiesCreated++;
  }

  // ─── Phase 2: CreatorProfile → AccountProfile (orphans provisioned) ─────────
  for (const cp of creatorProfiles) {
    const address = normalizeAddress(cp.walletAddress);
    let accountId = walletAddressToAccountId.get(address);

    if (!accountId) {
      const existingWallet = await prisma.wallet.findUnique({
        where: { chain_address: { chain: cp.chain, address } },
        select: { accountId: true },
      });
      if (existingWallet) {
        accountId = existingWallet.accountId;
      } else if (!dryRun) {
        const a = await prisma.$transaction(async (tx) => {
          const created = await tx.account.create({
            data: {
              publicId: generateAccountPublicId(),
              type: "PERSON",
              roles: ["CREATOR"],
              createdAt: cp.createdAt,
            },
          });
          await tx.wallet.create({
            data: {
              accountId: created.id,
              chain: cp.chain,
              address,
              walletType: "UNKNOWN",
              isPrimary: true,
              linkedAt: cp.createdAt,
            },
          });
          await tx.accountProfile.create({ data: { accountId: created.id } });
          return created;
        });
        accountId = a.id;
        walletAddressToAccountId.set(address, accountId);
        accountsCreated++;
        walletsCreated++;
        orphansProvisioned++;
        log.info({ address }, "orphan CreatorProfile: provisioned Account");
      } else {
        log.info({ address }, "DRY would provision orphan Account");
        orphansProvisioned++;
        continue;
      }
    } else {
      if (!dryRun) {
        const existing = await prisma.account.findUniqueOrThrow({
          where: { id: accountId },
          select: { roles: true },
        });
        if (!existing.roles.includes("CREATOR")) {
          await prisma.account.update({
            where: { id: accountId },
            data: { roles: { set: [...existing.roles, "CREATOR"] } },
          });
        }
      }
    }

    if (dryRun) {
      log.info({ address, hasUsername: !!cp.username }, "DRY would update AccountProfile");
      profilesUpdated++;
      continue;
    }

    await prisma.accountProfile.update({
      where: { accountId },
      data: {
        displayName: cp.displayName,
        bio: cp.bio,
        avatarImage: cp.avatarImage,
        bannerImage: cp.bannerImage,
        websiteUrl: cp.websiteUrl,
        twitterUrl: cp.twitterUrl,
        discordUrl: cp.discordUrl,
        telegramUrl: cp.telegramUrl,
        username: cp.username,
      },
    });
    profilesUpdated++;
  }

  // ─── Phase 3: Backfill accountId on reputation tables ────────────────────────
  let scoresLinked = 0;
  let badgesLinked = 0;
  let eventsLinked = 0;
  if (!dryRun) {
    scoresLinked = Number(
      await prisma.$executeRaw`
        UPDATE "UserScore" us
        SET "accountId" = w."accountId"
        FROM "Wallet" w
        WHERE w."chain" = us."chain" AND w."address" = us."address" AND us."accountId" IS NULL
      `,
    );
    badgesLinked = Number(
      await prisma.$executeRaw`
        UPDATE "UserBadge" ub
        SET "accountId" = w."accountId"
        FROM "Wallet" w
        WHERE w."address" = ub."address" AND ub."accountId" IS NULL
      `,
    );
    eventsLinked = Number(
      await prisma.$executeRaw`
        UPDATE "PointEvent" pe
        SET "accountId" = w."accountId"
        FROM "Wallet" w
        WHERE w."chain" = pe."chain" AND w."address" = pe."address" AND pe."accountId" IS NULL
      `,
    );
  }

  log.info(
    {
      accountsCreated,
      walletsCreated,
      identitiesCreated,
      profilesUpdated,
      orphansProvisioned,
      scoresLinked,
      badgesLinked,
      eventsLinked,
      dryRun,
    },
    "backfill complete",
  );
}

function mapAppSourceToProvider(
  walletType: WalletType,
  appSource: AppSource,
): IdentityProvider {
  if (walletType === "PRIVY") return "PRIVY";
  if (walletType === "CHIPIPAY") return "CHIPIPAY";
  if (appSource === "MEDIALANE_IO") return "CLERK";
  return "WALLET";
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
