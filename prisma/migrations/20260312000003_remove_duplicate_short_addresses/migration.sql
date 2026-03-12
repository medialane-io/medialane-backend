-- Remove Collection rows whose contractAddress is a short (non-padded) hex address
-- that already has a corresponding padded duplicate.
-- These were created by old code that used .toLowerCase() instead of normalizeAddress().

DELETE FROM "Collection"
WHERE length(substring("contractAddress" FROM 3)) < 64
  AND EXISTS (
    SELECT 1 FROM "Collection" c2
    WHERE c2.chain = "Collection".chain
      AND c2."contractAddress" = '0x' || lpad(substring("Collection"."contractAddress" FROM 3), 64, '0')
  );
