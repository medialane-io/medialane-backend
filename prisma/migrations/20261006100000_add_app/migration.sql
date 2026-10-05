-- An app is a row. An identity records the app it was registered through.
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

INSERT INTO "App" ("id", "name") VALUES
  ('MEDIALANE_API', 'Medialane API'),
  ('MEDIALANE_IO', 'Medialane.io'),
  ('MEDIALANE_STARKNET', 'Medialane'),
  ('MEDIALANE_PORTAL', 'Medialane Portal'),
  ('MEDIALANE_DAO', 'Medialane DAO');

ALTER TABLE "Identity" ADD COLUMN "appId" TEXT;
CREATE INDEX "Identity_appId_idx" ON "Identity"("appId");
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE SET NULL ON UPDATE CASCADE;
