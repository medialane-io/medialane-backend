-- AddIndex: Order(chain, status, nftContract) — orders-for-collection by status
CREATE INDEX IF NOT EXISTS "Order_chain_status_nftContract_idx" ON "Order"(chain, status, "nftContract");

-- AddIndex: Order(considerationToken) — currency filter
CREATE INDEX IF NOT EXISTS "Order_considerationToken_idx" ON "Order"("considerationToken");

-- AddIndex: Order(createdAt) — sort by recent
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");

-- AddIndex: Token(chain, isHidden) — hidden-content filter subquery
CREATE INDEX IF NOT EXISTS "Token_chain_isHidden_idx" ON "Token"(chain, "isHidden");

-- AddIndex: Collection(owner) — profile lookups
CREATE INDEX IF NOT EXISTS "Collection_owner_idx" ON "Collection"("owner");

-- AddIndex: Collection(chain, isHidden) — hidden-content filter subquery
CREATE INDEX IF NOT EXISTS "Collection_chain_isHidden_idx" ON "Collection"(chain, "isHidden");

-- AddIndex: RemixOffer(status, expiresAt) — reaper expiry query
CREATE INDEX IF NOT EXISTS "RemixOffer_status_expiresAt_idx" ON "RemixOffer"(status, "expiresAt");

-- AddIndex: TransactionIntent(expiresAt, status) — reaper expiry query
CREATE INDEX IF NOT EXISTS "TransactionIntent_expiresAt_status_idx" ON "TransactionIntent"("expiresAt", status);
