import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY);
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@northchannellogistics.com';

export async function sendEmail({ to, subject, html, text }: {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}) {
  return resend.emails.send({
    from: EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
  } as Parameters<typeof resend.emails.send>[0]);
}
