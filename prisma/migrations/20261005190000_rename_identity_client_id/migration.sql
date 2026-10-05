-- Identity.clientId references ApiCredits, like the other tables' apiCreditsId.
ALTER TABLE "Identity" RENAME COLUMN "clientId" TO "apiCreditsId";
ALTER TABLE "Identity" RENAME CONSTRAINT "Identity_clientId_fkey" TO "Identity_apiCreditsId_fkey";
ALTER INDEX "Identity_clientId_chain_address_key" RENAME TO "Identity_apiCreditsId_chain_address_key";
ALTER INDEX "Identity_clientId_idx" RENAME TO "Identity_apiCreditsId_idx";
ALTER INDEX "Identity_clientId_scheme_value_key" RENAME TO "Identity_apiCreditsId_scheme_value_key";
