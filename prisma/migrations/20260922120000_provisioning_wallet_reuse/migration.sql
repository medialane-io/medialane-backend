-- AlterEnum
ALTER TYPE "ProvisioningStatus" ADD VALUE 'REUSED' BEFORE 'HANDOFF';

-- AlterTable
ALTER TABLE "BusinessProvisioning" ALTER COLUMN "interimOwnerPubkey" DROP NOT NULL;
