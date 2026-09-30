-- Accounts carry no type or roles. Columns and enums go; no account row is touched.
ALTER TABLE "Account" DROP COLUMN "type";
ALTER TABLE "Account" DROP COLUMN "roles";

DROP TYPE "AccountType";
DROP TYPE "AccountRole";
