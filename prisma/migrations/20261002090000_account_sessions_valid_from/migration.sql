-- Sessions issued before this moment are no longer accepted. Null keeps every existing session valid; no row is touched.
ALTER TABLE "Account" ADD COLUMN "sessionsValidFrom" TIMESTAMP(3);
