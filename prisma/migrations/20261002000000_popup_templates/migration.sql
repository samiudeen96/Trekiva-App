-- CreateEnum
CREATE TYPE "PopupTemplate" AS ENUM ('CLASSIC', 'SPLIT', 'COUNTDOWN');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "countdownHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "declineText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "showCountdown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subtitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "template" "PopupTemplate" NOT NULL DEFAULT 'CLASSIC';

