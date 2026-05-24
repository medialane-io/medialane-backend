-- Add ApiKey.appSource for per-app traffic attribution.
--
-- Why: the audit (medialane-core/docs/audits/2026-05-24-backend-sdk-audit.md
-- finding P2-4) surfaced that 14 pre-HMAC keys are still active and
-- conflated across multiple apps. Per-app keys give us:
--   - per-app usage attribution via UsageLog.apiKeyId join
--   - leak-blast-radius isolation (rotate one app, others unaffected)
--   - future capability scoping (e.g., AGENT-only keys)
--
-- The column is nullable so legacy keys (all pre-2026-05-24) remain valid
-- until they're rotated through the per-app keys rotation playbook
-- (medialane-core/docs/plans/2026-05-24-apikey-per-app-rotation.md).
ALTER TABLE "ApiKey" ADD COLUMN "appSource" "AppSource";

CREATE INDEX "ApiKey_appSource_idx" ON "ApiKey"("appSource");
