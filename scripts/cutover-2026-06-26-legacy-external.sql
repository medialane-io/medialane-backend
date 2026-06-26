-- Cutover 2026-06-26 — new core protocol contracts are live.
-- Per the protocol-upgrade routine (no legacy support): prior-protocol collections
-- become read-only externals, and dead orders on the abandoned venues are pruned
-- while every real sale is preserved as permanent provenance.
--
-- Run (after reviewing the BEFORE counts):
--   railway run --service Postgres bash -c \
--     'psql "$DATABASE_PUBLIC_URL" -f scripts/cutover-2026-06-26-legacy-external.sql'

\echo '================ BEFORE ================'
\echo '-- collections that will reclassify (mip-* -> external-*)'
SELECT service, COUNT(*) FROM "Collection" WHERE service IN ('mip-erc721','mip-erc1155') GROUP BY service ORDER BY service;
\echo '-- order status distribution'
SELECT status, COUNT(*) FROM "Order" GROUP BY status ORDER BY status;
\echo '-- orders carrying real sales (FULFILLED or >=1 fill) — these are KEPT'
SELECT COUNT(*) AS kept_orders FROM "Order" o
  WHERE o.status = 'FULFILLED'
     OR EXISTS (SELECT 1 FROM "OrderFill" f WHERE f.chain = o.chain AND f."orderHash" = o."orderHash");
\echo '-- dead orders (no sale) — these are DELETED'
SELECT COUNT(*) AS deleted_orders FROM "Order" o
  WHERE o.status <> 'FULFILLED'
    AND NOT EXISTS (SELECT 1 FROM "OrderFill" f WHERE f.chain = o.chain AND f."orderHash" = o."orderHash");

BEGIN;

-- 1) Legacy collections -> read-only external. The current factories can no longer
--    mint into them, so they are provenance-only (viewable + tradable, never minted).
UPDATE "Collection" SET service = 'external-erc721'  WHERE service = 'mip-erc721';
UPDATE "Collection" SET service = 'external-erc1155' WHERE service = 'mip-erc1155';

-- 2) Prune dead orders on the abandoned venues. KEEP every FULFILLED order and every
--    order with >=1 OrderFill (partial-fill sales) so no real sale is ever lost;
--    DELETE the rest (live offers / cancels / expirations on contracts no longer used).
DELETE FROM "Order" o
WHERE o.status <> 'FULFILLED'
  AND NOT EXISTS (SELECT 1 FROM "OrderFill" f WHERE f.chain = o.chain AND f."orderHash" = o."orderHash");

COMMIT;

\echo '================ AFTER ================'
SELECT service, COUNT(*) FROM "Collection" WHERE service LIKE 'mip-erc%' OR service LIKE 'external-erc%' GROUP BY service ORDER BY service;
SELECT status, COUNT(*) FROM "Order" GROUP BY status ORDER BY status;
