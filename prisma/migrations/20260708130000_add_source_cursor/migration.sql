-- Durable per-source block cursors for slow-cadence mirror sources —
-- replaces the in-memory `_last*Block` module variables.
CREATE TABLE "SourceCursor" (
    "chain" "Chain" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceCursor_pkey" PRIMARY KEY ("chain","sourceId")
);
