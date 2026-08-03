-- CreateTable
CREATE TABLE "BlockTimestamp" (
    "chain" "Chain" NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockTimestamp_pkey" PRIMARY KEY ("chain","blockNumber")
);
