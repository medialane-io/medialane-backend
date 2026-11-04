-- Wallets and emails replaced before identities kept their history come back as INACTIVE rows on their
-- own account, rebuilt from the WALLET_REPLACED and EMAIL_CHANGED events. A wallet that another account
-- in the same app now holds is left out.
INSERT INTO "Identity" ("id", "accountId", "status", "scheme", "provider", "chain", "address", "appId")
SELECT DISTINCT ON (e.data->>'appId', e.data->>'chain', e.data->>'from')
  'restored_' || e."id", e."accountId", 'INACTIVE', 'wallet', 'unknown',
  (e.data->>'chain')::"Chain", e.data->>'from', e.data->>'appId'
FROM "AccountEvent" e
WHERE e."type" = 'WALLET_REPLACED'
  AND e.data->>'from' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Identity" i
    WHERE i."appId" = e.data->>'appId' AND i."chain" = (e.data->>'chain')::"Chain" AND i."address" = e.data->>'from'
  )
ORDER BY e.data->>'appId', e.data->>'chain', e.data->>'from', e."createdAt";

INSERT INTO "Identity" ("id", "accountId", "status", "scheme", "value", "appId")
SELECT DISTINCT ON (e."accountId", e.data->>'appId', e.data->>'from')
  'restored_' || e."id", e."accountId", 'INACTIVE', 'email', e.data->>'from', e.data->>'appId'
FROM "AccountEvent" e
WHERE e."type" = 'EMAIL_CHANGED'
  AND e.data->>'from' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Identity" i
    WHERE i."accountId" = e."accountId" AND i."appId" = e.data->>'appId' AND i."scheme" = 'email' AND i."value" = e.data->>'from'
  )
ORDER BY e."accountId", e.data->>'appId', e.data->>'from', e."createdAt";
