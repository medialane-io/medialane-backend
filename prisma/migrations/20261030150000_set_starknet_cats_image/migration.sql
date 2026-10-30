-- Set the Starknet Cats collection image.
UPDATE "Collection"
SET "image" = 'ipfs://bafkreihcptxps74chy2b76uucqy33y42gopjecinvnqsc4i2sa57tnwmt4'
WHERE "chain" = 'STARKNET'
  AND "contractAddress" = '0x045a4c4557cb7be24d6c2ba70fa8439307ee855cc69f9d80001727f1871b57bd';
