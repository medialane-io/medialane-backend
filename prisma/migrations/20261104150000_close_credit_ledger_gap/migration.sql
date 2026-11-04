-- Request charges made before every charge was written to the ledger changed creditBalance without an
-- entry. One USAGE entry per account records that difference, so each balance equals the sum of its
-- entries. Balances are not changed. A balance above its entries is left for the ledger check to report.
INSERT INTO "CreditEntry" ("id", "apiCreditsId", "kind", "credits", "note")
SELECT 'unrecorded_usage_' || ac."id", ac."id", 'USAGE', ac."creditBalance" - COALESCE(SUM(ce."credits"), 0),
       'request usage before 2026-11-04 that changed the balance without an entry'
FROM "ApiCredits" ac
LEFT JOIN "CreditEntry" ce ON ce."apiCreditsId" = ac."id"
GROUP BY ac."id"
HAVING ac."creditBalance" < COALESCE(SUM(ce."credits"), 0);
