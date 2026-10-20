-- AlterTable
ALTER TABLE "IgConnection" ADD COLUMN     "rightsCheckedAt" TIMESTAMP(3),
ADD COLUMN     "rightsJson" TEXT NOT NULL DEFAULT '';
