-- Every identity records the app it was registered through. Clients are matched by
-- the hash of their id; any other client belongs to the default app.
UPDATE "Identity" SET "appId" = CASE encode(sha256(convert_to("apiCreditsId", 'UTF8')), 'hex')
  WHEN '8c899c43482b7502adf7db7c3af8032ac4e1e2606ca92ac941a38c59df72848d' THEN 'MEDIALANE_IO'
  WHEN 'b528a45533f546e15b5005e215c7d7cbdcfc3ad7a843755ef80d147e0db00204' THEN 'MEDIALANE_STARKNET'
  WHEN '9c1751de5446af1977412a7f62953aa50cb02c3a2c16e0fbc64899823fd0aae0' THEN 'MEDIALANE_PORTAL'
  WHEN '13e09de0df168e7e796d989c570b255a89d6e0d9b43a0e2efb131d596472f692' THEN 'MEDIALANE_DAO'
  ELSE 'MEDIALANE_API'
END
WHERE "appId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Identity" WHERE "appId" IS NULL) THEN
    RAISE EXCEPTION 'Identity rows without an app remain';
  END IF;
END
$$;
