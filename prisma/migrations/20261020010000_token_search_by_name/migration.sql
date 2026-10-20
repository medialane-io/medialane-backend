-- Token search matches names; descriptions are read from each token's metadata when a token is requested.
DROP INDEX IF EXISTS idx_token_fts;

CREATE INDEX idx_token_fts
  ON "Token" USING GIN (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      "contractAddress" || ' ' ||
      "tokenId"
    )
  );
