-- Remove the redundant legacy identity tables. Data was verified 100% mirrored
-- in the current model BEFORE this migration (against a prod backup):
--   "User"           -> Account + Wallet + Identity   (all 59 addresses already migrated)
--   "CreatorProfile" -> AccountProfile                 (all usernames + bios mirrored; 0 unique)
-- The four code paths that read these (search, compute-rewards, the fix-wallet
-- admin tool, and the verify script) were repointed to AccountProfile/Wallet in
-- the same change, so nothing reads them at runtime.
--
-- Neither table has incoming foreign keys (both were standalone legacy tables),
-- so the drops are independent.

DROP TABLE "User";
DROP TABLE "CreatorProfile";
