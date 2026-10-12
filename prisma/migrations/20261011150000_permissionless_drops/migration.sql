-- CreateEnum
CREATE TYPE "DropMintKind" AS ENUM ('CLAIM', 'ISSUE');

-- AlterEnum
BEGIN;
CREATE TYPE "IntentType_new" AS ENUM ('CREATE_LISTING', 'MAKE_OFFER', 'FULFILL_ORDER', 'CANCEL_ORDER', 'MINT', 'CREATE_COLLECTION', 'COUNTER_OFFER', 'CREATE_TIER', 'CREATE_SPONSORSHIP_OFFER', 'SET_SPONSORSHIP_OFFER_OPEN', 'PLACE_SPONSORSHIP_BID', 'RETRACT_SPONSORSHIP_BID', 'ACCEPT_SPONSORSHIP_BID', 'CREATE_SPONSORSHIP_PROPOSAL', 'WITHDRAW_SPONSORSHIP_PROPOSAL', 'ACCEPT_SPONSORSHIP_PROPOSAL', 'REJECT_SPONSORSHIP_PROPOSAL', 'CREATE_COIN', 'LAUNCH_COIN', 'TRANSFER_TOKEN', 'TRANSFER_NFT', 'TRANSFER_COLLECTION_OWNERSHIP', 'ADD_COMMENT', 'GENESIS_MINT', 'POP_CLAIM', 'POP_BURN', 'DROP_CLAIM', 'WALLET_MANAGE', 'SWAP', 'FUNDING_TRANSFER', 'DROP_MANAGE', 'POP_MANAGE');
ALTER TABLE "TransactionIntent" ALTER COLUMN "type" TYPE "IntentType_new" USING ("type"::text::"IntentType_new");
ALTER TYPE "IntentType" RENAME TO "IntentType_old";
ALTER TYPE "IntentType_new" RENAME TO "IntentType";
DROP TYPE "IntentType_old";
COMMIT;

-- DropTable
DROP TABLE "PopAllowlist";

-- DropTable
DROP TABLE "DropClaimConditions";

-- CreateTable
CREATE TABLE "Drop" (
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "collectionAddress" TEXT NOT NULL,
    "dropId" TEXT NOT NULL,
    "organizer" TEXT NOT NULL,
    "maxSupply" DECIMAL(78,0) NOT NULL,
    "startTime" DECIMAL(20,0) NOT NULL,
    "endTime" DECIMAL(20,0) NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "paymentToken" TEXT NOT NULL,
    "maxPerWallet" DECIMAL(78,0) NOT NULL,
    "allowlistRoot" TEXT NOT NULL,
    "allowlistRootBlock" BIGINT NOT NULL,
    "minted" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "revenue" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "collectors" INTEGER NOT NULL DEFAULT 0,
    "createdBlock" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drop_pkey" PRIMARY KEY ("chain","collectionAddress")
);

-- CreateTable
CREATE TABLE "DropMint" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "collectionAddress" TEXT NOT NULL,
    "kind" "DropMintKind" NOT NULL,
    "wallet" TEXT NOT NULL,
    "quantity" DECIMAL(78,0) NOT NULL,
    "firstTokenId" DECIMAL(78,0) NOT NULL,
    "totalPaid" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DropMint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Drop_chain_organizer_idx" ON "Drop"("chain", "organizer");

-- CreateIndex
CREATE INDEX "Drop_chain_startTime_idx" ON "Drop"("chain", "startTime");

-- CreateIndex
CREATE INDEX "DropMint_chain_collectionAddress_blockNumber_idx" ON "DropMint"("chain", "collectionAddress", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DropMint_chain_collectionAddress_txHash_logIndex_key" ON "DropMint"("chain", "collectionAddress", "txHash", "logIndex");

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_chain_collectionAddress_fkey" FOREIGN KEY ("chain", "collectionAddress") REFERENCES "Collection"("chain", "contractAddress") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The drop factory source restarts from the factory's start block; the two
-- removed drop sources leave no cursor behind.
DELETE FROM "SourceCursor" WHERE "sourceId" IN ('factory:drop', 'allowlist:drop', 'conditions:drop');
