-- IP-Club's ClubRecord fields (open/entry fee/member cap) — a gap found
-- while building the Launchpad io/starknet join-club UX: the earlier
-- IP-Club migration only indexed the per-club club_nft Collection row, never
-- the registry's own ClubRecord state needed to actually build join_club
-- calls (fee amount, open/closed) or render membership caps.
-- Hand-written (local Postgres unavailable in this environment); applied in
-- prod via `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "ClubInfo" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "registryAddress" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "clubNftAddress" TEXT NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "numMembers" INTEGER NOT NULL DEFAULT 0,
    "maxMembers" INTEGER,
    "entryFee" TEXT,
    "paymentToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubInfo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubInfo_chain_registryAddress_clubId_key" ON "ClubInfo"("chain", "registryAddress", "clubId");
