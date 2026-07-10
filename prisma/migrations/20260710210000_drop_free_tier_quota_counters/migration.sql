-- There is no free tier: x402 credits meter every /v1 call, and nothing has
-- written these FREE-tier monthly quota counters since the per-minute rate
-- limiter replaced the DB-backed quota. Drop the frozen columns instead of
-- serving them as if they were live usage data.

ALTER TABLE "ApiKey" DROP COLUMN "monthlyRequestCount";
ALTER TABLE "ApiKey" DROP COLUMN "monthlyResetAt";
