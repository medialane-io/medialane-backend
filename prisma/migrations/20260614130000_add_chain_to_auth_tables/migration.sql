-- Multichain readiness (spec 2026-06-13 §3.5): the auth/claim challenge tables
-- were Starknet-implicit (wallet only). Add the chain dimension so an identity
-- is (chain, address). Default STARKNET so existing rows + current callers are
-- unaffected; these tables are short-lived (nonces/challenges expire).
ALTER TABLE "SiwsNonce" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';
ALTER TABLE "ClaimChallenge" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';
