-- Rewards & Ranking system
-- RewardLevel: 50 DAO-managed levels
CREATE TABLE "RewardLevel" (
  "level"       INTEGER NOT NULL,
  "name"        TEXT NOT NULL,
  "xpRequired"  INTEGER NOT NULL,
  "badgeColor"  TEXT NOT NULL DEFAULT '#6366f1',
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RewardLevel_pkey" PRIMARY KEY ("level")
);

-- RewardAction: per-action XP weights
CREATE TABLE "RewardAction" (
  "type"         TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "xp"           INTEGER NOT NULL,
  "dailyCap"     INTEGER,
  "minValueUsdc" DOUBLE PRECISION,
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RewardAction_pkey" PRIMARY KEY ("type")
);

-- RewardMultiplier: global multipliers
CREATE TABLE "RewardMultiplier" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "factor"      DOUBLE PRECISION NOT NULL,
  "condition"   TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RewardMultiplier_pkey" PRIMARY KEY ("id")
);

-- BadgeDefinition: badge catalogue
CREATE TABLE "BadgeDefinition" (
  "id"          TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "icon"        TEXT NOT NULL,
  "color"       TEXT NOT NULL DEFAULT '#6366f1',
  "category"    TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BadgeDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BadgeDefinition_key_key" ON "BadgeDefinition"("key");

-- UserScore: computed score per address
CREATE TABLE "UserScore" (
  "address"      TEXT NOT NULL,
  "chain"        "Chain" NOT NULL DEFAULT 'STARKNET',
  "totalXp"      INTEGER NOT NULL DEFAULT 0,
  "currentLevel" INTEGER NOT NULL DEFAULT 1,
  "breakdown"    JSONB NOT NULL DEFAULT '{}',
  "computedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserScore_pkey" PRIMARY KEY ("address")
);
CREATE INDEX "UserScore_totalXp_idx"      ON "UserScore"("totalXp");
CREATE INDEX "UserScore_currentLevel_idx" ON "UserScore"("currentLevel");
CREATE INDEX "UserScore_chain_idx"        ON "UserScore"("chain");

-- UserBadge: awarded badges
CREATE TABLE "UserBadge" (
  "id"        TEXT NOT NULL,
  "address"   TEXT NOT NULL,
  "badgeKey"  TEXT NOT NULL,
  "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "txHash"    TEXT,
  CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserBadge_address_badgeKey_key" ON "UserBadge"("address", "badgeKey");
CREATE INDEX "UserBadge_address_idx" ON "UserBadge"("address");
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeKey_fkey"
  FOREIGN KEY ("badgeKey") REFERENCES "BadgeDefinition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PointEvent: audit log
CREATE TABLE "PointEvent" (
  "id"         TEXT NOT NULL,
  "chain"      "Chain" NOT NULL DEFAULT 'STARKNET',
  "address"    TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "xp"         INTEGER NOT NULL,
  "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "finalXp"    INTEGER NOT NULL,
  "txHash"     TEXT,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PointEvent_address_idx"           ON "PointEvent"("address");
CREATE INDEX "PointEvent_actionType_idx"        ON "PointEvent"("actionType");
CREATE INDEX "PointEvent_createdAt_idx"         ON "PointEvent"("createdAt");
CREATE INDEX "PointEvent_chain_address_idx"     ON "PointEvent"("chain", "address");
