-- Fix short-address Collection rows.
-- Migration 20260312000002 failed (unique constraint) when both a short and
-- padded version of the same address existed simultaneously.
-- This migration safely handles all cases.

-- Step 1: Re-point any Token rows that reference a short-address collection
-- to the canonical padded address (handles FK constraint for Step 2).
UPDATE "Token"
SET "contractAddress" = '0x' || lpad(substring("contractAddress" FROM 3), 64, '0')
WHERE length(substring("contractAddress" FROM 3)) < 64
  AND EXISTS (
    SELECT 1 FROM "Collection" c
    WHERE c.chain = "Token".chain
      AND c."contractAddress" = '0x' || lpad(substring("Token"."contractAddress" FROM 3), 64, '0')
  );

-- Step 2: Delete Collection rows with a short address that already has a padded duplicate.
DELETE FROM "Collection"
WHERE length(substring("contractAddress" FROM 3)) < 64
  AND EXISTS (
    SELECT 1 FROM "Collection" c2
    WHERE c2.chain = "Collection".chain
      AND c2."contractAddress" = '0x' || lpad(substring("Collection"."contractAddress" FROM 3), 64, '0')
  );

-- Step 3: Normalize any remaining short-address Collection rows (no duplicate exists yet).
UPDATE "Collection"
SET "contractAddress" = '0x' || lpad(substring("contractAddress" FROM 3), 64, '0')
WHERE length(substring("contractAddress" FROM 3)) < 64;

-- Step 4: Normalize Collection.owner column.
UPDATE "Collection"
SET "owner" = '0x' || lpad(substring("owner" FROM 3), 64, '0')
WHERE "owner" IS NOT NULL
  AND length(substring("owner" FROM 3)) < 64;
