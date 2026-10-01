import nodemailer from "nodemailer";

export type OutgoingEmail = {
  to: string;
  from: string; // "Name <addr>" or "addr"
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
};

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<void>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Email provider responded ${res.status}: ${detail}`);
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  async send(e: OutgoingEmail) {
    await postJson(
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${need("RESEND_API_KEY")}` },
      {
        from: e.from,
        to: [e.to],
        subject: e.subject,
        text: e.text,
        html: e.html,
        ...(e.replyTo ? { reply_to: e.replyTo } : {}),
      },
    );
  }
}

export class PostmarkProvider implements EmailProvider {
  readonly name = "postmark";
  async send(e: OutgoingEmail) {
    await postJson(
      "https://api.postmarkapp.com/email",
      { "X-Postmark-Server-Token": need("POSTMARK_SERVER_TOKEN") },
      {
        From: e.from,
        To: e.to,
        Subject: e.subject,
        TextBody: e.text,
        HtmlBody: e.html,
        MessageStream: "outbound",
        ...(e.replyTo ? { ReplyTo: e.replyTo } : {}),
      },
    );
  }
}

function parseFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^(.*)<([^>]+)>\s*$/);
  return m ? { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() } : { email: from };
}

export class SendGridProvider implements EmailProvider {
  readonly name = "sendgrid";
  async send(e: OutgoingEmail) {
    await postJson(
      "https://api.sendgrid.com/v3/mail/send",
      { Authorization: `Bearer ${need("SENDGRID_API_KEY")}` },
      {
        personalizations: [{ to: [{ email: e.to }] }],
        from: parseFrom(e.from),
        subject: e.subject,
        content: [
          { type: "text/plain", value: e.text },
          { type: "text/html", value: e.html },
        ],
        ...(e.replyTo ? { reply_to: { email: e.replyTo } } : {}),
      },
    );
  }
}

export class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  async send(e: OutgoingEmail) {
    const transport = nodemailer.createTransport({
      host: need("SMTP_HOST"),
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
        : undefined,
      connectionTimeout: 10_000,
    });
    await transport.sendMail({
      from: e.from,
      to: e.to,
      replyTo: e.replyTo,
      subject: e.subject,
      text: e.text,
      html: e.html,
    });
  }
}

/** Development provider: prints the email instead of sending it. */
export class LogProvider implements EmailProvider {
  readonly name = "log";
  async send(e: OutgoingEmail) {
    console.log(`[email:log] to=${e.to} subject=${JSON.stringify(e.subject)}\n${e.text}`);
  }
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  switch ((env.EMAIL_PROVIDER || "log").toLowerCase()) {
    case "resend":
      return new ResendProvider();
    case "postmark":
      return new PostmarkProvider();
    case "sendgrid":
      return new SendGridProvider();
    case "smtp":
      return new SmtpProvider();
    case "log":
      return new LogProvider();
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${env.EMAIL_PROVIDER}"`);
  }
}
