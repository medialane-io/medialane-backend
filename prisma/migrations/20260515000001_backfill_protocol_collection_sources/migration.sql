-- Current Medialane ERC-721 protocol collections on mainnet.
UPDATE "Collection"
SET "source" = 'MEDIALANE_ERC721'::"CollectionSource"
WHERE "chain" = 'STARKNET'
  AND "contractAddress" IN (
    '0x0111e08c883b8387e7ecbe2b4b6a502a294f7443d1cc8075df34130439f5f0cf',
    '0x02da2fcd1611582243cab9cb74270eb9b5848ea512d9d3993e2d93daf8fc955a'
  );

-- Existing ERC-721 collections remain tradable, but are not mintable through the
-- current Medialane ERC-721 protocol.
UPDATE "Collection"
SET "source" = 'EXTERNAL_ERC721'::"CollectionSource"
WHERE "chain" = 'STARKNET'
  AND "source" = 'MEDIALANE_REGISTRY'::"CollectionSource"
  AND "contractAddress" NOT IN (
    '0x0111e08c883b8387e7ecbe2b4b6a502a294f7443d1cc8075df34130439f5f0cf',
    '0x02da2fcd1611582243cab9cb74270eb9b5848ea512d9d3993e2d93daf8fc955a'
  );

-- ERC-1155 factory collections are still mintable through their collection
-- contracts; classify them as Medialane ERC-1155.
UPDATE "Collection"
SET "source" = 'MEDIALANE_ERC1155'::"CollectionSource"
WHERE "chain" = 'STARKNET'
  AND "source" = 'ERC1155_FACTORY'::"CollectionSource";
