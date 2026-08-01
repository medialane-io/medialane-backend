-- CreateEnum
CREATE TYPE "WalletActivityType" AS ENUM ('SEND', 'RECEIVE', 'SWAP', 'DEPLOY', 'GUARDIAN_SET', 'GUARDIAN_TRIGGER_ESCAPE', 'GUARDIAN_COMPLETE_ESCAPE', 'GUARDIAN_CANCEL_ESCAPE');

-- CreateTable
CREATE TABLE "WalletActivity" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "accountAddress" TEXT NOT NULL,
    "type" "WalletActivityType" NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "tokenAddress" TEXT,
    "amount" TEXT,
    "counterparty" TEXT,
    "tokenInAddress" TEXT,
    "amountIn" TEXT,
    "tokenOutAddress" TEXT,
    "amountOut" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletActivityCursor" (
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "accountAddress" TEXT NOT NULL,
    "lastSyncedBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletActivityCursor_pkey" PRIMARY KEY ("chain","accountAddress")
);

-- CreateIndex
CREATE INDEX "WalletActivity_chain_accountAddress_timestamp_idx" ON "WalletActivity"("chain", "accountAddress", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "WalletActivity_chain_txHash_type_accountAddress_key" ON "WalletActivity"("chain", "txHash", "type", "accountAddress");
