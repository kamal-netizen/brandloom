/*
  Warnings:

  - The primary key for the `MediaObject` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "MediaObject" DROP CONSTRAINT "MediaObject_pkey",
ADD COLUMN     "part" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "MediaObject_pkey" PRIMARY KEY ("key", "part");
