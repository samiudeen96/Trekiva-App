import { Prisma, type PrismaClient, type StatType } from "@prisma/client";

/** Atomic counter increment (single upsert statement, safe under concurrency). Never throws. */
export async function bumpStat(
  db: PrismaClient,
  shop: string,
  campaignId: string,
  type: StatType,
  by = 1,
) {
  try {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "CampaignDailyStat" ("id","shop","campaignId","date","type","count")
      VALUES (${crypto.randomUUID()}, ${shop}, ${campaignId}, CURRENT_DATE, ${type}::"StatType", ${by})
      ON CONFLICT ("campaignId","date","type")
      DO UPDATE SET "count" = "CampaignDailyStat"."count" + ${by}`);
  } catch (err) {
    console.error("[stats] failed to record", type, err);
  }
}
