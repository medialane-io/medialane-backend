-- Add MEDIALANE_DAO so the dao site gets its own first-party app key/attribution
-- (per-app keys, no shared key across dapp/io/portal/dao). Standalone statement
-- (ADD VALUE can't share a tx with rows using the new value — none here).
ALTER TYPE "AppSource" ADD VALUE IF NOT EXISTS 'MEDIALANE_DAO';
