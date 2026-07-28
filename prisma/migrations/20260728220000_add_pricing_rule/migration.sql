-- x402 credit cost per action (chain, service) — business-set, admin-editable.
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'ALL',
    "service" TEXT NOT NULL DEFAULT 'ALL',
    "credits" INTEGER NOT NULL,
    "label" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PricingRule_actionKey_chain_service_key" ON "PricingRule"("actionKey", "chain", "service");

CREATE INDEX "PricingRule_actionKey_idx" ON "PricingRule"("actionKey");
