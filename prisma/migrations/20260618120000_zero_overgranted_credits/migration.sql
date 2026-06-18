-- CORRECTION: the x402 migration (20260617000000) blanket-granted 1,000,000
-- credits to EVERY existing tenant — a mistake. Credits are paid/granted value;
-- only our own apps should hold granted credits, everyone else starts at 0 and
-- pays via x402.
--
-- Zero every tenant EXCEPT the four first-party app tenants (provisioned by
-- `bun run seed-app-tenants`, matched by email). Order-independent: if the app
-- tenants don't exist yet they're created funded later; if they do, they're
-- preserved here. Runs exactly once (migration).
UPDATE "Tenant"
SET "creditBalance" = 0
WHERE "email" NOT IN (
  'medialanedapp@gmail.com',
  'medialaneio@gmail.com',
  'medialanexyz@gmail.com',
  'medialanedao@gmail.com'
);
