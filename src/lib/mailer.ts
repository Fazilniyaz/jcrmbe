import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "./logger";

/*
 * Outbound mail over Gmail SMTP with an App Password.
 *
 * With GMAIL_APP_PASSWORD empty the transport is never created and every send
 * is logged instead. That keeps local development working without credentials
 * and — importantly — means a missing secret degrades to "the invite link is in
 * the server log" rather than a failed company creation.
 */

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!env.mailEnabled) return null;
  transporter ??= nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    /*
     * Pooled, because the alternative is a fresh TCP + TLS + SMTP AUTH
     * handshake per message. Against Gmail that is seconds of wall clock, and
     * it used to be seconds a request handler sat and waited for.
     */
    pool: true,
    maxConnections: 3,
    // A hung SMTP socket must not become a hung invite. These bound each
    // stage so a send fails in seconds rather than hanging until the OS
    // gives up on the connection.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * Hand a message to the transport and return immediately.
 *
 * Delivery is not part of the request that triggered it. Awaiting `sendMail`
 * in a route handler put a Gmail round trip — seconds, and unbounded when the
 * network is unhappy — between the user pressing Save and the row appearing,
 * which is what made creating an employee feel like the app had frozen.
 *
 * The trade is that the caller learns "handed off", not "delivered". That is
 * the honest answer anyway: SMTP acceptance was never proof of delivery, and
 * every invite has a Resend button for when it does not arrive. Failures go to
 * the log, which is where the previous `sent: false` was really being read.
 */
export function queueMail(mail: Mail): { queued: boolean } {
  // `void` rather than a floating promise: sendMail never rejects, so there is
  // nothing to catch, and this makes the fire-and-forget deliberate.
  void sendMail(mail);
  return { queued: env.mailEnabled };
}

/**
 * Send, or log and carry on.
 *
 * Never throws: an SMTP outage must not roll back a company that was already
 * created, and the invite can be re-sent. The caller is told whether it went.
 * Prefer `queueMail` from a request handler — see the note there.
 */
export async function sendMail(mail: Mail): Promise<{ sent: boolean }> {
  const transport = getTransport();

  if (!transport) {
    logger.warn(
      { to: mail.to, subject: mail.subject, preview: mail.text },
      "mail not configured — GMAIL_APP_PASSWORD is empty, logging instead of sending",
    );
    return { sent: false };
  }

  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
    logger.info({ to: mail.to, subject: mail.subject }, "mail sent");
    return { sent: true };
  } catch (err) {
    logger.error({ err, to: mail.to, subject: mail.subject }, "mail send failed");
    return { sent: false };
  }
}

/* ---------------------------------------------------------- templates -- */

/** Minimal escaping — every interpolated value below is user-supplied. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(heading: string, body: string, cta: { label: string; url: string }): string {
  return `<!doctype html>
<html><body style="margin:0;background:#f5f6fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2b2b3c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:8px;padding:32px">
        <tr><td>
          <p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6c5ffc;font-weight:600">Jadvix</p>
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${esc(heading)}</h1>
          <div style="font-size:14px;line-height:1.6;color:#4b4b63">${body}</div>
          <p style="margin:28px 0 0">
            <a href="${esc(cta.url)}" style="display:inline-block;background:#6c5ffc;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;font-weight:600">${esc(cta.label)}</a>
          </p>
          <p style="margin:24px 0 0;font-size:12px;color:#8b8ba7">
            If the button doesn't work, paste this into your browser:<br>
            <span style="word-break:break-all">${esc(cta.url)}</span>
          </p>
          <p style="margin:24px 0 0;font-size:12px;color:#8b8ba7">
            This link can be used once and expires. If you weren't expecting it, ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function ownerInviteMail(input: {
  to: string;
  ownerName: string;
  companyName: string;
  url: string;
}): Mail {
  const text = [
    `Hi ${input.ownerName},`,
    ``,
    `${input.companyName} has been set up on Jadvix and you have been made its administrator.`,
    `Set your password to activate the account:`,
    ``,
    input.url,
    ``,
    `The link can be used once and expires in 3 days.`,
  ].join("\n");

  return {
    to: input.to,
    subject: `Activate ${input.companyName} on Jadvix`,
    text,
    html: layout(
      `Set up ${esc(input.companyName)}`,
      `<p>Hi ${esc(input.ownerName)}, ${esc(input.companyName)} has been set up on Jadvix and you have been made its administrator.</p>
       <p>Choose a password to activate the account and sign in.</p>`,
      { label: "Set your password", url: input.url },
    ),
  };
}

export function employeeInviteMail(input: {
  to: string;
  name: string;
  companyName: string;
  url: string;
}): Mail {
  const text = [
    `Hi ${input.name},`,
    ``,
    `You have been added to ${input.companyName} on Jadvix.`,
    `Set your password to activate your account:`,
    ``,
    input.url,
    ``,
    `The link can be used once and expires in 3 days.`,
  ].join("\n");

  return {
    to: input.to,
    subject: `Your ${input.companyName} account on Jadvix`,
    text,
    html: layout(
      `Welcome to ${esc(input.companyName)}`,
      `<p>Hi ${esc(input.name)}, you have been added to ${esc(input.companyName)} on Jadvix.</p>
       <p>Choose a password to activate your account.</p>`,
      { label: "Set your password", url: input.url },
    ),
  };
}
