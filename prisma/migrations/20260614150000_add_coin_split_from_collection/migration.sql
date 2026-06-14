-- Fungible coins get their own table; Collection becomes NFT-only.
-- Spec: medialane-core/docs/specs/2026-06-14-coin-collection-split-design.md
--
-- PRE-APPLY CHECK (prod): SELECT name, "contractAddress" FROM "Collection" WHERE standard='ERC20';
-- (today: "Brother Eli", "STARKNET BROTHER"; both have zero Token rows.)

CREATE TABLE "Coin" (
  "id"              TEXT NOT NULL,
  "chain"           "Chain" NOT NULL DEFAULT 'STARKNET',
  "contractAddress" TEXT NOT NULL,
  "standard"        "TokenStandard" NOT NULL DEFAULT 'ERC20',
  "service"         TEXT NOT NULL,
  "name"            TEXT,
  "symbol"          TEXT,
  "decimals"        INTEGER NOT NULL DEFAULT 18,
  "totalSupply"     TEXT,
  "description"     TEXT,
  "image"           TEXT,
  "creator"         TEXT,
  "startBlock"      BIGINT NOT NULL,
  "isHidden"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Coin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Coin_chain_contractAddress_key" ON "Coin"("chain","contractAddress");
CREATE INDEX "Coin_chain_service_idx" ON "Coin"("chain","service");
CREATE INDEX "Coin_chain_isHidden_idx" ON "Coin"("chain","isHidden");

-- Copy existing ERC-20 Collection rows into Coin (creator carried from claimedBy).
INSERT INTO "Coin" ("id","chain","contractAddress","standard","service","name","symbol","decimals","totalSupply","description","image","creator","startBlock","isHidden","createdAt","updatedAt")
SELECT "id","chain","contractAddress",'ERC20',"service","name","symbol",18,
       NULLIF("totalSupply",0)::text,"description","image","claimedBy","startBlock","isHidden","createdAt",CURRENT_TIMESTAMP
FROM "Collection" WHERE "standard"='ERC20';

-- Remove any stray NFT-shaped rows for those ERC-20 contracts (defensive; expected 0).
DELETE FROM "TokenBalance" tb USING "Collection" c WHERE c."standard"='ERC20' AND tb."chain"=c."chain" AND tb."contractAddress"=c."contractAddress";
DELETE FROM "Transfer" t USING "Collection" c WHERE c."standard"='ERC20' AND t."chain"=c."chain" AND t."contractAddress"=c."contractAddress";
DELETE FROM "Token" t USING "Collection" c WHERE c."standard"='ERC20' AND t."chain"=c."chain" AND t."contractAddress"=c."contractAddress";

-- Coins leave Collection.
DELETE FROM "Collection" WHERE "standard"='ERC20';
