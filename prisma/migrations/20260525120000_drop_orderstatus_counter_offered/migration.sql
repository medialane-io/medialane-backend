-- Drop COUNTER_OFFERED from OrderStatus.
--
-- Counter-offers are linked orders via `parentOrderHash`, not a third
-- lifecycle state on the parent bid (01-core-model §V). The backend stops
-- writing the value in the same release (intents/build.ts:174). Consumer
-- apps (medialane-io, medialane-dapp) already switched their tab predicate
-- to the derived `hasActiveCounterOffer` flag.
--
-- Phase B + C of audit P0-1.

-- Phase B (data backfill): any existing row that's stuck on COUNTER_OFFERED
-- → back to ACTIVE. The child counter still exists with parentOrderHash, so
-- `hasActiveCounterOffer` on the parent will render correctly post-migration.
UPDATE "Order" SET status = 'ACTIVE' WHERE status = 'COUNTER_OFFERED';

-- Phase C (schema): Postgres does not support DROP VALUE on enums; recreate
-- the type without the value and migrate the column.
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
CREATE TYPE "OrderStatus" AS ENUM ('ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus" USING "status"::text::"OrderStatus";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
DROP TYPE "OrderStatus_old";
