-- Add ERC20 to the TokenStandard enum so Creator Coins (fixed-supply ERC-20
-- launchpad, service "creator-coin") can be indexed as Collections.
-- Hand-written per the enum-addition pitfall in CLAUDE.md (shadow-DB / CREATE
-- INDEX CONCURRENTLY blocks `prisma migrate dev` for enum additions).
ALTER TYPE "TokenStandard" ADD VALUE IF NOT EXISTS 'ERC20';
