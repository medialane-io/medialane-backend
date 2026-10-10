-- Full-text search GIN indexes for Token and Collection

CREATE INDEX IF NOT EXISTS idx_token_fts
  ON "Token" USING GIN (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      "contractAddress" || ' ' ||
      "tokenId"
    )
  );

CREATE INDEX IF NOT EXISTS idx_collection_fts
  ON "Collection" USING GIN (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      "contractAddress"
    )
  );
