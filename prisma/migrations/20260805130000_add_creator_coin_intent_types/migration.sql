-- Add CREATE_COIN / LAUNCH_COIN to IntentType enum — closes the
-- pop-protocol/drop-collection/creator-coin backend-bypass gap (POP/Drop route
-- through the existing CREATE_COLLECTION type via a new `service`; creator-coin
-- needs its own two-step CREATE_COIN → LAUNCH_COIN shape, mirroring CREATE_TIER → MINT).
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in PostgreSQL
ALTER TYPE "IntentType" ADD VALUE IF NOT EXISTS 'CREATE_COIN';
ALTER TYPE "IntentType" ADD VALUE IF NOT EXISTS 'LAUNCH_COIN';
