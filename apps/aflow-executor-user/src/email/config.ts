/**
 * Email configuration — loaded from environment variables.
 *
 * Supports two env var prefixes:
 *   - SES_*     (preferred — matches existing .env conventions)
 *   - EMAIL_*   (fallback)
 *
 * Enable with EMAIL_ENABLED=true or by having SES_SMTP_HOST set.
 */

export interface EmailConfig {
  enabled: boolean;
  provider: 'ses_smtp';
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };
  from: {
    address: string;
    name: string;
  };
  replyTo?: string | undefined;
  sesConfigurationSet?: string | undefined;
  maxSubjectLength: number;
  maxContentBytes: number;
}

/**
 * Read an env var with SES_ prefix first, then EMAIL_ fallback.
 */
function env(sesKey: string, emailKey: string): string | undefined {
  return process.env[sesKey] || process.env[emailKey] || undefined;
}

/**
 * Load email configuration from environment.
 *
 * Auto-enables when SES_SMTP_HOST (or EMAIL_SMTP_HOST) is set,
 * or when EMAIL_ENABLED=true. Returns disabled config otherwise.
 */
export function loadEmailConfig(): EmailConfig {
  const host = env('SES_SMTP_HOST', 'EMAIL_SMTP_HOST');
  const explicitEnabled = process.env['EMAIL_ENABLED'] === 'true';
  const enabled = explicitEnabled || !!host;

  if (!enabled) {
    return {
      enabled: false,
      provider: 'ses_smtp',
      smtp: { host: '', port: 587, secure: false, username: '', password: '' },
      from: { address: '', name: '' },
      maxSubjectLength: 200,
      maxContentBytes: 100_000,
    };
  }

  const smtpHost = requireEnvDual('SES_SMTP_HOST', 'EMAIL_SMTP_HOST');
  const port = parseInt(env('SES_SMTP_PORT', 'EMAIL_SMTP_PORT') ?? '587', 10);
  const secure = env('SES_SMTP_SECURE', 'EMAIL_SMTP_SECURE') === 'true';
  const username = requireEnvDual('SES_SMTP_USERNAME', 'EMAIL_SMTP_USERNAME');
  const password = requireEnvDual('SES_SMTP_PASSWORD', 'EMAIL_SMTP_PASSWORD');
  const fromAddress = requireEnvDual('SES_FROM_ADDRESS', 'EMAIL_FROM_ADDRESS');
  const fromName = env('SES_FROM_NAME', 'EMAIL_FROM_NAME') ?? 'Aflow';
  const replyTo = env('SES_REPLY_TO', 'EMAIL_REPLY_TO');
  const sesConfigurationSet = env('SES_CONFIGURATION_SET', 'EMAIL_SES_CONFIGURATION_SET');
  const maxSubjectLength = parseInt(
    env('SES_MAX_SUBJECT_LENGTH', 'EMAIL_MAX_SUBJECT_LENGTH') ?? '200',
    10,
  );
  const maxContentBytes = parseInt(
    env('SES_MAX_CONTENT_BYTES', 'EMAIL_MAX_CONTENT_BYTES') ?? '100000',
    10,
  );

  return {
    enabled: true,
    provider: 'ses_smtp',
    smtp: { host: smtpHost, port, secure, username, password },
    from: { address: fromAddress, name: fromName },
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(sesConfigurationSet !== undefined ? { sesConfigurationSet } : {}),
    maxSubjectLength,
    maxContentBytes,
  };
}

function requireEnvDual(sesKey: string, emailKey: string): string {
  const value = env(sesKey, emailKey);
  if (!value) {
    throw new Error(`Email enabled but neither ${sesKey} nor ${emailKey} is set`);
  }
  return value;
}
