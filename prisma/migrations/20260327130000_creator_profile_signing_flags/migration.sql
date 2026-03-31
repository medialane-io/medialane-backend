-- CreatorProfile: preferred Chipi encryption for signing (PIN vs PASSKEY).
-- If you already applied the earlier boolean-column version of this migration locally, drop those columns first:
--   ALTER TABLE "CreatorProfile" DROP COLUMN IF EXISTS "pinSavedForTransactions";
--   ALTER TABLE "CreatorProfile" DROP COLUMN IF EXISTS "passkeySavedForTransactions";
--   ALTER TABLE "CreatorProfile" DROP COLUMN IF EXISTS "transactionSigningSavedAt";

CREATE TYPE "WalletEncryptionPreference" AS ENUM ('PIN', 'PASSKEY');

ALTER TABLE "CreatorProfile" ADD COLUMN "preferredEncryption" "WalletEncryptionPreference";
ALTER TABLE "CreatorProfile" ADD COLUMN "preferredEncryptionUpdatedAt" TIMESTAMP(3);
