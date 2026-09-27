/**
 * SMTP transport — wraps Nodemailer for SES SMTP delivery.
 *
 * Initialized once at startup. Reused for all send_email operations.
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailConfig } from './config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  messageId: string;
}

let _transporter: Transporter | null = null;

/**
 * Create and cache the SMTP transporter.
 * Should be called once at startup when email is enabled.
 */
export function initTransport(config: EmailConfig): Transporter {
  const headers: Record<string, string> = {};
  if (config.sesConfigurationSet) {
    headers['X-SES-CONFIGURATION-SET'] = config.sesConfigurationSet;
  }

  _transporter = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.username,
      pass: config.smtp.password,
    },
    headers,
  });

  return _transporter;
}

/**
 * Send an email through the configured SMTP transport.
 */
export async function sendEmail(config: EmailConfig, message: EmailMessage): Promise<SendResult> {
  if (!_transporter) {
    throw new Error('SMTP transport not initialized — call initTransport() first');
  }

  const from = config.from.name
    ? `"${config.from.name}" <${config.from.address}>`
    : config.from.address;

  const info = (await _transporter.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(config.replyTo ? { replyTo: config.replyTo } : {}),
  })) as { messageId: unknown };

  return { messageId: String(info.messageId) };
}

/**
 * Verify the SMTP connection is working.
 */
export async function verifyTransport(): Promise<void> {
  if (!_transporter) {
    throw new Error('SMTP transport not initialized');
  }
  await _transporter.verify();
}
