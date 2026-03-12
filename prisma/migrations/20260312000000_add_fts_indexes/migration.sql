-- Full-text search GIN indexes for Token and Collection
-- NOTE: CONCURRENTLY cannot run inside a transaction. These statements run outside
-- any implicit transaction wrapper. On Prisma migrate deploy, each statement is
-- executed sequentially; CONCURRENTLY is safe here because no wrapping BEGIN/COMMIT
-- is issued around individual statements in a migration file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_fts
  ON "Token" USING GIN (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      "contractAddress" || ' ' ||
      "tokenId"
    )
  );

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collection_fts
  ON "Collection" USING GIN (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      "contractAddress"
    )
  );
