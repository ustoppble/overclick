import { Resend } from "resend";

/**
 * The one way this app sends email: a thin wrapper over Resend, read from
 * `RESEND_API_KEY` and `EMAIL_FROM`. Both are optional for the instance as a
 * whole — a board without them runs exactly as before, only what needs to
 * send mail (sign-in by code) says it is unavailable.
 *
 * Nothing it logs carries the recipient, the body or the key: a log line is
 * the one place a sign-in code could otherwise end up in clear.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/** Sends `message` and says whether it went out. Never throws. */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    console.error("[email] RESEND_API_KEY or EMAIL_FROM is not set; nothing was sent");
    return false;
  }

  try {
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    if (error) {
      // Only the error's kind: Resend's message can quote the recipient.
      console.error(`[email] Resend refused the message (${error.name ?? "unknown"})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[email] sending failed (${err instanceof Error ? err.name : "unknown"})`,
    );
    return false;
  }
}
