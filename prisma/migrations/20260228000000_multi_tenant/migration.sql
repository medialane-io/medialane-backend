-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MetadataStatus" AS ENUM ('PENDING', 'FETCHING', 'FETCHED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('METADATA_FETCH', 'METADATA_PIN', 'STATS_UPDATE', 'WEBHOOK_DELIVER');

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('FREE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "WebhookEventType" AS ENUM ('ORDER_CREATED', 'ORDER_FULFILLED', 'ORDER_CANCELLED', 'TRANSFER');

-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "IntentType" AS ENUM ('CREATE_LISTING', 'MAKE_OFFER', 'FULFILL_ORDER', 'CANCEL_ORDER');

-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('PENDING', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastBlock" BIGINT NOT NULL,
    "continuationToken" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderHash" TEXT NOT NULL,
    "offerer" TEXT NOT NULL,
    "offerItemType" INTEGER NOT NULL,
    "offerToken" TEXT NOT NULL,
    "offerIdentifier" TEXT NOT NULL,
    "offerStartAmount" TEXT NOT NULL,
    "offerEndAmount" TEXT NOT NULL,
    "considerationItemType" INTEGER NOT NULL,
    "considerationToken" TEXT NOT NULL,
    "considerationIdentifier" TEXT NOT NULL,
    "considerationStartAmount" TEXT NOT NULL,
    "considerationEndAmount" TEXT NOT NULL,
    "considerationRecipient" TEXT NOT NULL,
    "startTime" BIGINT NOT NULL,
    "endTime" BIGINT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "fulfiller" TEXT,
    "createdBlockNumber" BIGINT NOT NULL,
    "createdTxHash" TEXT NOT NULL,
    "fulfilledTxHash" TEXT,
    "cancelledTxHash" TEXT,
    "nftContract" TEXT,
    "nftTokenId" TEXT,
    "priceRaw" TEXT,
    "priceFormatted" TEXT,
    "currencySymbol" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "tokenUri" TEXT,
    "metadataStatus" "MetadataStatus" NOT NULL DEFAULT 'PENDING',
    "name" TEXT,
    "description" TEXT,
    "image" TEXT,
    "attributes" JSONB,
    "ipType" TEXT,
    "licenseType" TEXT,
    "commercialUse" BOOLEAN,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "name" TEXT,
    "startBlock" BIGINT NOT NULL,
    "isKnown" BOOLEAN NOT NULL DEFAULT false,
    "floorPrice" TEXT,
    "totalVolume" TEXT,
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "totalSupply" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "processAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionIntent" (
    "id" TEXT NOT NULL,
    "type" "IntentType" NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'PENDING',
    "requester" TEXT NOT NULL,
    "typedData" JSONB NOT NULL,
    "calls" JSONB NOT NULL,
    "signature" TEXT[],
    "txHash" TEXT,
    "orderHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetadataCache" (
    "id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "resolvedUrl" TEXT,
    "content" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "ttlSeconds" INTEGER NOT NULL DEFAULT 86400,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetadataCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "plan" "TenantPlan" NOT NULL DEFAULT 'FREE',
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" "WebhookEventType"[],
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "jobId" TEXT,
    "eventType" "WebhookEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderHash_key" ON "Order"("orderHash");

-- CreateIndex
CREATE INDEX "Order_offerer_idx" ON "Order"("offerer");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_nftContract_nftTokenId_idx" ON "Order"("nftContract", "nftTokenId");

-- CreateIndex
CREATE INDEX "Token_owner_idx" ON "Token"("owner");

-- CreateIndex
CREATE INDEX "Token_contractAddress_idx" ON "Token"("contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Token_contractAddress_tokenId_key" ON "Token"("contractAddress", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_contractAddress_key" ON "Collection"("contractAddress");

-- CreateIndex
CREATE INDEX "Transfer_contractAddress_tokenId_idx" ON "Transfer"("contractAddress", "tokenId");

-- CreateIndex
CREATE INDEX "Transfer_toAddress_idx" ON "Transfer"("toAddress");

-- CreateIndex
CREATE INDEX "Transfer_fromAddress_idx" ON "Transfer"("fromAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_txHash_logIndex_key" ON "Transfer"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Job_status_processAfter_idx" ON "Job"("status", "processAfter");

-- CreateIndex
CREATE INDEX "TransactionIntent_requester_idx" ON "TransactionIntent"("requester");

-- CreateIndex
CREATE INDEX "TransactionIntent_status_idx" ON "TransactionIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MetadataCache_uri_key" ON "MetadataCache"("uri");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_email_key" ON "Tenant"("email");

-- CreateIndex
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

-- CreateIndex
CREATE INDEX "Tenant_plan_idx" ON "Tenant"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

-- CreateIndex
CREATE INDEX "ApiKey_status_idx" ON "ApiKey"("status");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_idx" ON "WebhookEndpoint"("tenantId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_status_idx" ON "WebhookEndpoint"("status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_idx" ON "WebhookDelivery"("endpointId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_eventType_idx" ON "WebhookDelivery"("eventType");

-- CreateIndex
CREATE INDEX "UsageLog_tenantId_createdAt_idx" ON "UsageLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLog_apiKeyId_createdAt_idx" ON "UsageLog"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_nftContract_nftTokenId_fkey" FOREIGN KEY ("nftContract", "nftTokenId") REFERENCES "Token"("contractAddress", "tokenId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "Collection"("contractAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_contractAddress_tokenId_fkey" FOREIGN KEY ("contractAddress", "tokenId") REFERENCES "Token"("contractAddress", "tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

