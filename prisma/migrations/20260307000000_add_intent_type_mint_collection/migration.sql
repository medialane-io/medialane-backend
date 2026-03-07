-- Add MINT and CREATE_COLLECTION to IntentType enum
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in PostgreSQL
ALTER TYPE "IntentType" ADD VALUE IF NOT EXISTS 'MINT';
ALTER TYPE "IntentType" ADD VALUE IF NOT EXISTS 'CREATE_COLLECTION';
