-- Set the Relics collection image.
UPDATE "Collection"
SET "image" = 'ipfs://bafkreignejcczg3qwrvv5aplhiflvnnqwwyg7bmimf3anlfhohdlj2u25q'
WHERE "chain" = 'STARKNET'
  AND "contractAddress" = '0x06f63afcf7b5251c82df3b01090b2b43e81727ec5350f7f0a3a6f43203bcc63a';
