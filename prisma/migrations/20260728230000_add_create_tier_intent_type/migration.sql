-- Adds the CREATE_TIER intent type (ip-tickets create_ticket / ip-club
-- create_membership — a setup step mip-erc721/ip-erc721 don't have).
ALTER TYPE "IntentType" ADD VALUE 'CREATE_TIER';
