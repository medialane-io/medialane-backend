-- Register Starkamigos (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x01f046b5d86503f18380df5a8cc15c8453334f4586705794b5288acb94624ec0',
  'external-erc721',
  'ERC721',
  671657,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;

-- Set the Starkamigos collection image.
UPDATE "Collection"
SET "image" = 'ipfs://bafkreiex2boi6p6bidbnjel5pceq6rizpmyx35rajenpm6plcawj3ynvwe'
WHERE "chain" = 'STARKNET'
  AND "contractAddress" = '0x01f046b5d86503f18380df5a8cc15c8453334f4586705794b5288acb94624ec0';
