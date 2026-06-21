-- Re-tag legacy MIP-Collections-ERC721 v0.3.0 collections (registry 0x0322cb71…) as external-erc721.
--
-- The immutable v0.4.0 registry (0x0558c9b6…, per-token EIP-2981 royalties) was deployed on
-- 2026-06-20 at Starknet block 11002817 and supersedes the prior registry. Per the redeploy
-- convention (medialane keeps no legacy protocol support), prior-version collections are
-- reclassified `external-*` (read-only external provenance): they stay fully viewable and
-- tradeable, but drop out of the `mip-erc721` minting surfaces (e.g. the create-asset collection
-- picker), where selecting one would fail `is_collection_owner` against the empty v0.4.0 registry.
--
-- Scoped by `startBlock` so this is safe regardless of when it runs: future v0.4.0 collections
-- (created at block >= 11002817) are never affected — only legacy rows are re-tagged.
UPDATE "Collection"
SET service = 'external-erc721'
WHERE service = 'mip-erc721'
  AND "startBlock" < 11002817;
