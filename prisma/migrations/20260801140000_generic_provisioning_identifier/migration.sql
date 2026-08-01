-- Replace the email-only recipientEmail column with a generic, free-form
-- identifier (mirrors Identity.scheme/value, 07-identity §II — the platform
-- never enumerates valid identity schemes). No data migration needed: this
-- table has never shipped to a deployed environment.
ALTER TABLE "BusinessProvisioning" DROP COLUMN "recipientEmail",
ADD COLUMN     "recipientScheme" TEXT NOT NULL,
ADD COLUMN     "recipientValue" TEXT NOT NULL;
