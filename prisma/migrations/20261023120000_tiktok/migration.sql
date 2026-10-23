-- TikTok (Login Kit + Content Posting API, Direct Post)

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "tiktokJson" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "TiktokConnection" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "username" TEXT,
    "avatarUrl" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "refreshingAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TiktokConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TiktokConnection_brandId_key" ON "TiktokConnection"("brandId");

-- CreateIndex
CREATE INDEX "TiktokConnection_openId_idx" ON "TiktokConnection"("openId");

-- AddForeignKey
ALTER TABLE "TiktokConnection" ADD CONSTRAINT "TiktokConnection_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
