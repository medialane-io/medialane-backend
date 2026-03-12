-- Normalize Collection.contractAddress and Collection.owner to 64-char padded hex
-- to match the normalizeAddress() utility used everywhere else in the codebase.
-- Rows already at 64 hex chars are untouched.

UPDATE "Collection"
SET "contractAddress" = '0x' || lpad(substring("contractAddress" FROM 3), 64, '0')
WHERE length(substring("contractAddress" FROM 3)) < 64;

UPDATE "Collection"
SET "owner" = '0x' || lpad(substring("owner" FROM 3), 64, '0')
WHERE "owner" IS NOT NULL
  AND length(substring("owner" FROM 3)) < 64;
