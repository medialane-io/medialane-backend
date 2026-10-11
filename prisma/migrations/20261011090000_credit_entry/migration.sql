CREATE TYPE "CreditEntryKind" AS ENUM ('OPENING', 'PAYMENT', 'GRANT', 'USAGE', 'REFUND');
CREATE TABLE "CreditEntry" (
    "id" TEXT NOT NULL,
    "apiCreditsId" TEXT NOT NULL,
    "kind" "CreditEntryKind" NOT NULL,
    "credits" INTEGER NOT NULL,
    "paymentId" TEXT,
    "usageEventId" TEXT,
    "launchpadRunId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreditEntry_apiCreditsId_createdAt_idx" ON "CreditEntry"("apiCreditsId", "createdAt");
CREATE INDEX "CreditEntry_paymentId_idx" ON "CreditEntry"("paymentId");
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_apiCreditsId_fkey" FOREIGN KEY ("apiCreditsId") REFERENCES "ApiCredits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE FUNCTION "credit_entry_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CreditEntry is append-only';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "credit_entry_append_only" BEFORE UPDATE OR DELETE ON "CreditEntry" FOR EACH ROW EXECUTE FUNCTION "credit_entry_append_only"();
