-- Register Stark foxes (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x033f5b9e36018ee80b9577e79c42dbfaacd0176eb1e2b6a2ecd78864fc50adb4',
  'external-erc721',
  'ERC721',
  374585,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
