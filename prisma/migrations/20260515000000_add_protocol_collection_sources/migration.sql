-- Add protocol-aware collection source values.
-- Keep existing values for API/backward compatibility during rollout.
ALTER TYPE "CollectionSource" ADD VALUE IF NOT EXISTS 'MEDIALANE_ERC721';
ALTER TYPE "CollectionSource" ADD VALUE IF NOT EXISTS 'MEDIALANE_ERC1155';
ALTER TYPE "CollectionSource" ADD VALUE IF NOT EXISTS 'EXTERNAL_ERC721';
ALTER TYPE "CollectionSource" ADD VALUE IF NOT EXISTS 'EXTERNAL_ERC1155';
