import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { loadEmailConfig } from '../email/config.js';

describe('loadEmailConfig', () => {
  const originalEnv = { ...process.env };

  // Every setting falls back SES_* → EMAIL_*, so a developer with a real .env in
  // their shell silently supplies whichever key a test does not set — a fallback
  // assertion then reads the ambient preferred key and fails on a machine-specific
  // value. Strip by prefix rather than by name so a new setting cannot reintroduce
  // the leak.
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SES_') || key.startsWith('EMAIL_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns disabled config when no SMTP host is set', () => {
    const config = loadEmailConfig();
    expect(config.enabled).toBe(false);
  });

  it('auto-enables when SES_SMTP_HOST is set', () => {
    process.env['SES_SMTP_HOST'] = 'smtp.example.com';
    process.env['SES_SMTP_USERNAME'] = 'user';
    process.env['SES_SMTP_PASSWORD'] = 'pass';
    process.env['SES_FROM_ADDRESS'] = 'test@example.com';

    const config = loadEmailConfig();
    expect(config.enabled).toBe(true);
    expect(config.smtp.host).toBe('smtp.example.com');
  });

  it('prefers SES_ prefix over EMAIL_ prefix', () => {
    process.env['SES_SMTP_HOST'] = 'ses-host.example.com';
    process.env['EMAIL_SMTP_HOST'] = 'email-host.example.com';
    process.env['SES_SMTP_USERNAME'] = 'user';
    process.env['SES_SMTP_PASSWORD'] = 'pass';
    process.env['SES_FROM_ADDRESS'] = 'test@example.com';

    const config = loadEmailConfig();
    expect(config.smtp.host).toBe('ses-host.example.com');
  });

  it('falls back to EMAIL_ prefix', () => {
    process.env['EMAIL_ENABLED'] = 'true';
    process.env['EMAIL_SMTP_HOST'] = 'smtp.example.com';
    process.env['EMAIL_SMTP_USERNAME'] = 'user';
    process.env['EMAIL_SMTP_PASSWORD'] = 'pass';
    process.env['EMAIL_FROM_ADDRESS'] = 'test@example.com';

    const config = loadEmailConfig();
    expect(config.enabled).toBe(true);
    expect(config.smtp.host).toBe('smtp.example.com');
  });

  it('throws when enabled but SMTP username is missing', () => {
    process.env['SES_SMTP_HOST'] = 'smtp.example.com';
    expect(() => loadEmailConfig()).toThrow('SES_SMTP_USERNAME');
  });

  it('uses defaults for optional fields', () => {
    process.env['SES_SMTP_HOST'] = 'smtp.example.com';
    process.env['SES_SMTP_USERNAME'] = 'user';
    process.env['SES_SMTP_PASSWORD'] = 'pass';
    process.env['SES_FROM_ADDRESS'] = 'test@example.com';

    const config = loadEmailConfig();
    expect(config.from.name).toBe('Aflow');
    expect(config.maxSubjectLength).toBe(200);
    expect(config.maxContentBytes).toBe(100_000);
  });
});
