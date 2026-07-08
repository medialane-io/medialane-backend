-- Remove the IP-Tickets / IP-Club / IP-Sponsorship services from the platform
-- (spec: medialane-core/docs/specs/2026-07-08-backend-uniform-digital-assets-design.md).
-- No production usage exists; every purged row is a chain-rebuildable projection.

-- Purge indexed rows for the removed services.
DELETE FROM "Comment"      WHERE ("chain", "contractAddress") IN (SELECT "chain", "contractAddress" FROM "Collection" WHERE "service" IN ('ip-tickets','ip-club'));
DELETE FROM "TokenBalance" WHERE ("chain", "contractAddress") IN (SELECT "chain", "contractAddress" FROM "Collection" WHERE "service" IN ('ip-tickets','ip-club'));
DELETE FROM "Transfer"     WHERE ("chain", "contractAddress") IN (SELECT "chain", "contractAddress" FROM "Collection" WHERE "service" IN ('ip-tickets','ip-club'));
DELETE FROM "Order"        WHERE ("chain", "nftContract")     IN (SELECT "chain", "contractAddress" FROM "Collection" WHERE "service" IN ('ip-tickets','ip-club'));
DELETE FROM "Token"        WHERE ("chain", "contractAddress") IN (SELECT "chain", "contractAddress" FROM "Collection" WHERE "service" IN ('ip-tickets','ip-club'));
DELETE FROM "Collection"   WHERE "service" IN ('ip-tickets','ip-club');

-- Drop the per-service side tables.
DROP TABLE IF EXISTS "SponsorshipLicense";
DROP TABLE IF EXISTS "SponsorshipBid";
DROP TABLE IF EXISTS "SponsorshipOffer";
DROP TABLE IF EXISTS "ClubInfo";
DROP TABLE IF EXISTS "TicketCollectionInfo";
DROP TYPE IF EXISTS "SponsorshipBidStatus";

-- Drop the IP-Tickets-only columns from the universal Token table.
ALTER TABLE "Token" DROP COLUMN IF EXISTS "redeemed";
ALTER TABLE "Token" DROP COLUMN IF EXISTS "ticketCollectionId";
