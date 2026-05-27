-- Drop AirdropSignup. The table represented a parallel "airdrop user"
-- concept that doesn't exist on the platform: signups from /airdrop,
-- /mint, /br/mint all flow through the standard Clerk + ChipiPay
-- onboarding into Account / Wallet / Identity / AccountProfile, exactly
-- like signups from anywhere else. The table had no real callers and
-- one verification row.

DROP INDEX IF EXISTS "AirdropSignup_createdAt_idx";
DROP INDEX IF EXISTS "AirdropSignup_role_idx";
DROP INDEX IF EXISTS "AirdropSignup_email_key";
DROP TABLE IF EXISTS "AirdropSignup";
