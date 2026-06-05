-- Add BASE (EVM L2) to the Chain enum.
-- Manual migration: `prisma migrate dev` blocks on enum additions
-- (shadow DB CREATE INDEX CONCURRENTLY) — see medialane-backend/CLAUDE.md.
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'BASE';
