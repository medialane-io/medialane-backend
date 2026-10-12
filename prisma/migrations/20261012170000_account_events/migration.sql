CREATE TYPE "AccountEventType" AS ENUM ('EMAIL_CHANGED', 'WALLET_REPLACED', 'WALLET_KEY_ADDED', 'API_KEY_CREATED', 'API_KEY_DELETED', 'STATUS_CHANGED');
CREATE TABLE "AccountEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "AccountEventType" NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountEvent_accountId_createdAt_idx" ON "AccountEvent"("accountId", "createdAt");
ALTER TABLE "AccountEvent" ADD CONSTRAINT "AccountEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION "account_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AccountEvent is append-only';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "account_event_append_only" BEFORE UPDATE OR DELETE ON "AccountEvent" FOR EACH ROW EXECUTE FUNCTION "account_event_append_only"();
