INSERT INTO "CreditEntry" ("id", "apiCreditsId", "kind", "credits", "createdAt")
SELECT 'opening_' || ac."id", ac."id", 'OPENING', ac."creditBalance" - COALESCE(s."total", 0), CURRENT_TIMESTAMP
FROM "ApiCredits" ac
LEFT JOIN (SELECT "apiCreditsId", SUM("credits") AS "total" FROM "CreditEntry" GROUP BY "apiCreditsId") s
  ON s."apiCreditsId" = ac."id"
WHERE ac."creditBalance" - COALESCE(s."total", 0) <> 0;
