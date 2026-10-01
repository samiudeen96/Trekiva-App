-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "DiscountMode" AS ENUM ('SHARED', 'UNIQUE');

-- CreateEnum
CREATE TYPE "TriggerMode" AS ENUM ('DELAY', 'EXIT_INTENT');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('EVERY_PAGE_LOAD', 'EVERY_REFRESH', 'ONCE_PER_SESSION', 'ONCE_EVERY_X_DAYS', 'UNTIL_CLAIMED');

-- CreateEnum
CREATE TYPE "DeviceTarget" AS ENUM ('ALL', 'DESKTOP', 'MOBILE');

-- CreateEnum
CREATE TYPE "PageTarget" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'SENT', 'EMAIL_FAILED', 'FAILED', 'INELIGIBLE');

-- CreateEnum
CREATE TYPE "StatType" AS ENUM ('VIEW', 'SUBMISSION', 'CLAIM', 'DUPLICATE', 'EMAIL_SENT', 'EMAIL_FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT 'Get 10% Off Your First Order',
    "description" TEXT NOT NULL DEFAULT 'Join our list and we''ll email your welcome discount code.',
    "buttonText" TEXT NOT NULL DEFAULT 'Get 10% Off',
    "emailPlaceholder" TEXT NOT NULL DEFAULT 'Enter your email address',
    "successMessage" TEXT NOT NULL DEFAULT 'Your 10% welcome offer is on its way! Check your inbox for your discount code.',
    "alreadyClaimedMessage" TEXT NOT NULL DEFAULT 'You''ve already claimed your welcome offer. Please check your inbox for your discount code.',
    "notEligibleMessage" TEXT NOT NULL DEFAULT 'This welcome offer is only available on a first order.',
    "errorMessage" TEXT NOT NULL DEFAULT 'Something went wrong. Please try again in a moment.',
    "privacyNote" TEXT NOT NULL DEFAULT '',
    "backgroundColor" TEXT NOT NULL DEFAULT '#ffffff',
    "textColor" TEXT NOT NULL DEFAULT '#1a1a1a',
    "buttonColor" TEXT NOT NULL DEFAULT '#1a1a1a',
    "buttonTextColor" TEXT NOT NULL DEFAULT '#ffffff',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "discountValue" DECIMAL(10,2) NOT NULL DEFAULT 10,
    "discountMode" "DiscountMode" NOT NULL DEFAULT 'SHARED',
    "sharedCode" TEXT NOT NULL DEFAULT 'WELCOME10',
    "codePrefix" TEXT NOT NULL DEFAULT 'WELCOME10',
    "expiryDays" INTEGER,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT true,
    "oncePerCustomer" BOOLEAN NOT NULL DEFAULT true,
    "createCustomer" BOOLEAN NOT NULL DEFAULT true,
    "tagCustomer" BOOLEAN NOT NULL DEFAULT true,
    "customerTag" TEXT NOT NULL DEFAULT 'welcome10_claimed',
    "triggerMode" "TriggerMode" NOT NULL DEFAULT 'DELAY',
    "delaySeconds" INTEGER NOT NULL DEFAULT 5,
    "minPageViews" INTEGER NOT NULL DEFAULT 1,
    "frequency" "Frequency" NOT NULL DEFAULT 'ONCE_EVERY_X_DAYS',
    "frequencyDays" INTEGER NOT NULL DEFAULT 7,
    "stopAfterClaim" BOOLEAN NOT NULL DEFAULT true,
    "deviceTarget" "DeviceTarget" NOT NULL DEFAULT 'ALL',
    "pageTarget" "PageTarget" NOT NULL DEFAULT 'ALL',
    "pagePaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emailSubject" TEXT NOT NULL DEFAULT 'Welcome to {{ shop_name }} — here''s {{ discount_value }} off your first order',
    "emailBody" TEXT NOT NULL DEFAULT 'Thanks for joining {{ shop_name }}.

Use the code below to get {{ discount_value }} off your first order:

{{ discount_code }}

Shop now:
{{ shop_url }}',
    "emailFromName" TEXT NOT NULL DEFAULT '',
    "emailFromAddress" TEXT NOT NULL DEFAULT '',
    "emailReplyTo" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WelcomeClaim" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "shopifyDiscountId" TEXT,
    "discountCode" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailSentAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WelcomeClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDailyStat" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "StatType" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CampaignDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "Campaign_shop_active_idx" ON "Campaign"("shop", "active");

-- CreateIndex
CREATE INDEX "WelcomeClaim_shop_email_idx" ON "WelcomeClaim"("shop", "email");

-- CreateIndex
CREATE INDEX "WelcomeClaim_shop_discountCode_idx" ON "WelcomeClaim"("shop", "discountCode");

-- CreateIndex
CREATE INDEX "WelcomeClaim_campaignId_status_idx" ON "WelcomeClaim"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WelcomeClaim_shop_campaignId_email_key" ON "WelcomeClaim"("shop", "campaignId", "email");

-- CreateIndex
CREATE INDEX "CampaignDailyStat_shop_date_idx" ON "CampaignDailyStat"("shop", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDailyStat_campaignId_date_type_key" ON "CampaignDailyStat"("campaignId", "date", "type");

-- AddForeignKey
ALTER TABLE "WelcomeClaim" ADD CONSTRAINT "WelcomeClaim_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDailyStat" ADD CONSTRAINT "CampaignDailyStat_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

