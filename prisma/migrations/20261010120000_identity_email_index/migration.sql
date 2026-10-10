DROP INDEX "Identity_appId_scheme_value_key";

CREATE INDEX "Identity_appId_scheme_value_idx" ON "Identity"("appId", "scheme", "value");
