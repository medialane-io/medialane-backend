-- ============================================================================
-- Unify the identity model: fold Wallet into the free-form Identity table, drop
-- the platform-gating enums (WalletType, IdentityProvider), and rename the
-- AppSource value MEDIALANE_DAPP -> MEDIALANE_STARKNET.
--
-- A wallet is now ONE KIND of Identity (07-identity §II): scheme='wallet', keyed
-- by (chain, address). Social/email logins are scheme='clerk' / 'email' / …,
-- keyed by (scheme, value). 'value' is the old providerUserId.
--
-- DATA-PRESERVING. The "Wallet" table is authoritative for wallets (it carries
-- chain/address/walletType/isPrimary); the old Identity rows label wallets
-- inconsistently (io wallets were CHIPIPAY/CLERK, not WALLET), so we reshape
-- against "Wallet", not against the old provider enum. Existing rows are reshaped
-- IN PLACE so their appSource / email / createdAt survive. Nothing is dropped
-- until every wallet exists as a scheme='wallet' Identity.
--
-- NOTE: hand-written (enum drops + data backfill). Test against a restore of the
-- prod backup and run `bun run verify-accounts` before deploying.
-- ============================================================================

-- 1. AppSource value rename (in place — existing rows update automatically).
ALTER TYPE "AppSource" RENAME VALUE 'MEDIALANE_DAPP' TO 'MEDIALANE_STARKNET';

-- 2. Move the old columns aside and add the new shape.
ALTER TABLE "Identity" RENAME COLUMN "provider" TO "_old_provider";   -- IdentityProvider enum
ALTER TABLE "Identity" ALTER COLUMN "_old_provider" DROP NOT NULL;    -- step-7 inserts don't set it
ALTER TABLE "Identity" RENAME COLUMN "providerUserId" TO "value";     -- becomes the off-chain identifier
ALTER TABLE "Identity" ALTER COLUMN "value" DROP NOT NULL;            -- wallet identities have no `value`

ALTER TABLE "Identity" ADD COLUMN "scheme"    TEXT;
ALTER TABLE "Identity" ADD COLUMN "provider"  TEXT;
ALTER TABLE "Identity" ADD COLUMN "chain"     "Chain";
ALTER TABLE "Identity" ADD COLUMN "address"   TEXT;
ALTER TABLE "Identity" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- 3. Reshape the existing wallet Identity row in place. The wallet row is the one
--    whose old providerUserId ends with the wallet's address and is NOT the clerk
--    auth row ("…:clerk:<addr>"). walletType / isPrimary come from "Wallet".
UPDATE "Identity" i
SET scheme      = 'wallet',
    chain       = w."chain",
    address     = w."address",
    provider    = lower(w."walletType"::text),
    "isPrimary" = w."isPrimary",
    value       = NULL
FROM "Wallet" w
WHERE i."accountId" = w."accountId"
  AND i."value" LIKE ('%' || w."address")
  AND i."value" NOT LIKE '%:clerk:%';

-- 4. Clerk auth rows ("…:clerk:<addr>") become scheme='clerk' (value keeps the subject).
UPDATE "Identity"
SET scheme = 'clerk', provider = 'clerk'
WHERE scheme IS NULL AND "value" LIKE '%:clerk:%';

-- 5. Orphan wallet rows whose "Wallet" was already gone — parse (chain,address) from value.
UPDATE "Identity"
SET scheme   = 'wallet',
    provider = 'unknown',
    chain    = NULLIF(split_part("value", ':', 2), '')::"Chain",
    address  = split_part("value", ':', 3),
    value    = NULL
WHERE scheme IS NULL AND "value" LIKE 'wallet:%';

-- 6. Anything still unassigned keeps its old provider name as the scheme (email / privy / …).
UPDATE "Identity"
SET scheme   = lower("_old_provider"::text),
    provider = lower("_old_provider"::text)
WHERE scheme IS NULL;

-- 7. Create a wallet Identity for any "Wallet" that had no Identity row at all.
INSERT INTO "Identity" (id, "accountId", scheme, provider, chain, address, "appSource", "isPrimary", "verifiedAt", "createdAt")
SELECT gen_random_uuid()::text, w."accountId", 'wallet', lower(w."walletType"::text),
       w."chain", w."address", 'MEDIALANE_STARKNET', w."isPrimary", w."verifiedAt", w."linkedAt"
FROM "Wallet" w
WHERE NOT EXISTS (
  SELECT 1 FROM "Identity" i
  WHERE i.scheme = 'wallet' AND i.chain = w."chain" AND i.address = w."address"
);

-- 8. scheme is populated on every row now — enforce it.
ALTER TABLE "Identity" ALTER COLUMN "scheme" SET NOT NULL;

-- 9. Swap constraints + indexes to the new shape.
DROP INDEX IF EXISTS "Identity_provider_providerUserId_key";
ALTER TABLE "Identity" DROP COLUMN "_old_provider";
CREATE UNIQUE INDEX "Identity_chain_address_key" ON "Identity" ("chain", "address");
CREATE UNIQUE INDEX "Identity_scheme_value_key"  ON "Identity" ("scheme", "value");
CREATE INDEX "Identity_address_idx" ON "Identity" ("address");

-- 10. Drop the Wallet table — its data now lives in scheme='wallet' Identity rows.
DROP TABLE "Wallet";

-- 11. Drop the now-unused, platform-gating enums.
DROP TYPE "WalletType";
DROP TYPE "IdentityProvider";
