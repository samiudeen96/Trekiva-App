import type { Campaign } from "@prisma/client";
import { providerFromEnv, type EmailProvider } from "./providers.server";
import { renderHtml, renderSubject, renderText, type EmailVars } from "./template";

export interface Mailer {
  sendDiscountEmail(args: {
    to: string;
    campaign: Pick<
      Campaign,
      "emailSubject" | "emailBody" | "emailFromName" | "emailFromAddress" | "emailReplyTo"
    >;
    vars: EmailVars;
  }): Promise<void>;
}

function stripHeaderChars(s: string) {
  return s.replace(/[\r\n"<>]/g, "").trim();
}

export function createMailer(provider: EmailProvider = providerFromEnv()): Mailer {
  return {
    async sendDiscountEmail({ to, campaign, vars }) {
      const address = campaign.emailFromAddress || process.env.EMAIL_FROM_ADDRESS;
      if (!address) throw new Error("No sender address: set EMAIL_FROM_ADDRESS or the campaign sender");
      const name = campaign.emailFromName || process.env.EMAIL_FROM_NAME || vars.shop_name;
      const from = name ? `${stripHeaderChars(name)} <${stripHeaderChars(address)}>` : address;
      await provider.send({
        to,
        from,
        replyTo: campaign.emailReplyTo || undefined,
        subject: renderSubject(campaign.emailSubject, vars),
        text: renderText(campaign.emailBody, vars),
        html: renderHtml(campaign.emailBody, vars),
      });
    },
  };
}
