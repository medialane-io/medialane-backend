-- AlterTable
ALTER TABLE "Identity" ADD COLUMN     "app" TEXT;

-- CreateTable
CREATE TABLE "App" (
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "emailConfirmDays" INTEGER,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "App_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "App_clientId_key" ON "App"("clientId");

-- CreateIndex
CREATE INDEX "Identity_app_idx" ON "Identity"("app");

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_app_fkey" FOREIGN KEY ("app") REFERENCES "App"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

