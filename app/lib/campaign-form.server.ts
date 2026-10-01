import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1a1a1a");
const bool = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());
const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const campaignSchema = z
  .object({
    name: text(80).min(1, "Name is required"),
    active: bool,

    template: z.enum(["CLASSIC", "SPLIT", "COUNTDOWN"]),
    subtitle: text(80),
    showCountdown: bool,
    countdownHours: intIn(1, 720),
    declineText: text(40),

    title: text(120).min(1, "Title is required"),
    description: text(400),
    buttonText: text(40).min(1, "Button text is required"),
    emailPlaceholder: text(80),
    successMessage: text(300).min(1),
    alreadyClaimedMessage: text(300).min(1),
    notEligibleMessage: text(300).min(1),
    errorMessage: text(300).min(1),
    privacyNote: text(300),

    backgroundColor: color,
    textColor: color,
    buttonColor: color,
    buttonTextColor: color,
    imageUrl: z.string().trim().max(500).refine((v) => v === "" || /^https:\/\//.test(v), "Image URL must start with https://"),

    discountType: z.enum(["PERCENTAGE", "FIXED"]),
    discountValue: z.coerce.number().positive().max(100000),
    discountMode: z.enum(["SHARED", "UNIQUE"]),
    sharedCode: text(50),
    codePrefix: text(20),
    expiryDays: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().min(1).max(3650).nullable()),
    firstOrderOnly: bool,
    oncePerCustomer: bool,

    createCustomer: bool,
    tagCustomer: bool,
    customerTag: text(40),

    triggerMode: z.enum(["DELAY", "EXIT_INTENT"]),
    delaySeconds: intIn(0, 300),
    minPageViews: intIn(1, 10),
    frequency: z.enum(["EVERY_PAGE_LOAD", "EVERY_REFRESH", "ONCE_PER_SESSION", "ONCE_EVERY_X_DAYS", "UNTIL_CLAIMED"]),
    frequencyDays: intIn(1, 365),
    stopAfterClaim: bool,
    deviceTarget: z.enum(["ALL", "DESKTOP", "MOBILE"]),
    pageTarget: z.enum(["ALL", "SELECTED"]),
    pagePaths: z.string().transform((s) =>
      s
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.startsWith("/") ? p : `/${p}`))
        .slice(0, 50),
    ),

    emailSubject: text(200).min(1, "Subject is required"),
    emailBody: text(5000).min(1, "Email body is required"),
    emailFromName: text(80),
    emailFromAddress: z.string().trim().max(254).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid sender email"),
    emailReplyTo: z.string().trim().max(254).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid reply-to email"),
  })
  .superRefine((v, ctx) => {
    if (v.discountType === "PERCENTAGE" && v.discountValue > 100) {
      ctx.addIssue({ code: "custom", path: ["discountValue"], message: "Percentage cannot exceed 100" });
    }
    if (v.discountMode === "SHARED" && !v.sharedCode) {
      ctx.addIssue({ code: "custom", path: ["sharedCode"], message: "Enter the existing Shopify discount code" });
    }
    if (v.pageTarget === "SELECTED" && v.pagePaths.length === 0) {
      ctx.addIssue({ code: "custom", path: ["pagePaths"], message: "Add at least one page path" });
    }
    if (v.emailBody && !/\{\{\s*discount_code\s*\}\}/.test(v.emailBody)) {
      ctx.addIssue({ code: "custom", path: ["emailBody"], message: "The email body must include {{ discount_code }}" });
    }
  });

export type CampaignInput = z.infer<typeof campaignSchema>;

/** Returns parsed data or a field -> message map. */
export function parseCampaignForm(form: FormData) {
  const raw: Record<string, FormDataEntryValue> = {};
  for (const [k, v] of form.entries()) raw[k] = v;
  const result = campaignSchema.safeParse(raw);
  if (result.success) return { ok: true as const, data: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return { ok: false as const, errors };
}
