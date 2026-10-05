-- An ApiClient that holds nothing is created again the first time it is needed.
DELETE FROM "ApiClient" c
WHERE c."creditBalance" = 0
  AND c."plan" = 'FREE'
  AND NOT EXISTS (SELECT 1 FROM "ApiKey" x WHERE x."apiClientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "WebhookEndpoint" x WHERE x."apiClientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "Payment" x WHERE x."apiClientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "FundingIntent" x WHERE x."apiClientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "UsageEvent" x WHERE x."apiClientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "LaunchpadRun" x WHERE x."apiClientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "Identity" x WHERE x."clientId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "App" x WHERE x."clientId" = c."id");
