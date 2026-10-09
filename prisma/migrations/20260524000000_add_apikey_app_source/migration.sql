-- Add ApiKey.appSource for per-app traffic attribution.
--
-- Per-app keys give us:
--   - per-app usage attribution via UsageLog.apiKeyId join
--   - leak-blast-radius isolation (rotate one app, others unaffected)
--   - future capability scoping (e.g., AGENT-only keys)
--
-- The column is nullable so legacy keys remain valid until they're rotated.
ALTER TABLE "ApiKey" ADD COLUMN "appSource" "AppSource";

CREATE INDEX "ApiKey_appSource_idx" ON "ApiKey"("appSource");
