-- IP-Tickets inner per-batch grouping (TicketCollectionInfo) + Token linkage
-- (ticketCollectionId). One deployed IPTicketCollection can hold multiple
-- ticket collections (events/tiers); this was missing from the first
-- IP-Tickets migration, which only covered outer-level factory discovery.
-- Hand-written (local Postgres unavailable in this environment); applied in
-- prod via `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "Token" ADD COLUMN "ticketCollectionId" TEXT;

-- CreateTable
CREATE TABLE "TicketCollectionInfo" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "contractAddress" TEXT NOT NULL,
    "ticketCollectionId" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "maxSupply" TEXT NOT NULL,
    "minted" TEXT NOT NULL,
    "expiration" BIGINT NOT NULL,
    "royaltyBps" INTEGER NOT NULL,
    "paymentToken" TEXT,
    "metadataUri" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketCollectionInfo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketCollectionInfo_chain_contract_ticketCollectionId_key" ON "TicketCollectionInfo"("chain", "contractAddress", "ticketCollectionId");
