-- Add index on (chain, ipType) for efficient IP type filtering on the Token table
CREATE INDEX IF NOT EXISTS "Token_chain_ipType_idx" ON "Token"("chain", "ipType");
