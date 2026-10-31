/**
 * What `yarn channel:slack setup` writes, read through the app that reads it.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelRedisConfig, loadChannelSlackConfig, parseEnvText } from '../config.js';
import { keyExpiryNotice } from '../keyExpiry.js';
import {
  CHANNEL_REDIS_PASSWORD_ENV,
  channelRedisUrlOf,
  instanceWithChannelCredential,
  serializeChannelSlackEnv,
} from '../../scripts/setup.mjs';
import { KEY_EXPIRES_IN_DAYS } from '../../../../scripts/mcp-local-setup.mjs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-setup-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the channel credential in instance.env', () => {
  it('is appended once, leaving every other line as it was', () => {
    const instance = "PHOENIX_INSTANCE_SECRET='s'\nREDIS_PASSWORD='r'\n";
    const addition = instanceWithChannelCredential(instance, 'c'.repeat(64));
    expect(addition).toBe(`${CHANNEL_REDIS_PASSWORD_ENV}='${'c'.repeat(64)}'\n`);
    expect(instanceWithChannelCredential(`${instance}${String(addition)}`, 'd'.repeat(64))).toBe(
      undefined,
    );
  });

  it('is the variable the platform composes the lane on', () => {
    expect(CHANNEL_REDIS_PASSWORD_ENV).toBe('PHOENIX_CHANNEL_REDIS_PASSWORD');
  });
});

describe('the app’s file', () => {
  it('round-trips through the app’s own reader', () => {
    const text = serializeChannelSlackEnv({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_APP_TOKEN: 'xapp-1',
      AFLOW_API_URL: 'http://localhost:3000',
      AFLOW_API_KEY: "phx_it's",
      AFLOW_TENANT_ID: 'tenant-1',
      AFLOW_USER_ID: 'owner-1',
      CHANNEL_REDIS_URL: channelRedisUrlOf({ REDIS_URL: 'redis://:stack-secret@127.0.0.1:6379' }),
      CHANNEL_REDIS_PASSWORD: 'c'.repeat(64),
      PHOENIX_PAYLOAD_DIR: undefined,
    });
    writeFileSync(join(dir, 'channel-slack.env'), text, { mode: 0o600 });

    const config = loadChannelSlackConfig(dir);
    expect(config.CHANNEL_REDIS_URL).toBe('redis://127.0.0.1:6379');
    expect(text).not.toContain('stack-secret');
    expect(config.PHOENIX_PAYLOAD_DIR).toBeUndefined();
    expect(parseEnvText("A='x'\n")).toEqual({ A: 'x' });
  });

  it('connects as the channel identity, never with the stack’s password', () => {
    const redis = channelRedisConfig({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_APP_TOKEN: 'xapp-1',
      AFLOW_API_URL: 'http://localhost:3000',
      AFLOW_API_KEY: 'phx_1',
      AFLOW_TENANT_ID: 'tenant-1',
      AFLOW_USER_ID: 'owner-1',
      CHANNEL_REDIS_URL: 'redis://127.0.0.1:6379',
      CHANNEL_REDIS_PASSWORD: 'c'.repeat(64),
    });
    expect(redis.url).toBe(`redis://channelexec:${'c'.repeat(64)}@127.0.0.1:6379`);
    expect(redis.password).toBeUndefined();
  });

  it('refuses a missing file with the command that writes it', () => {
    expect(() => loadChannelSlackConfig(join(dir, 'absent'))).toThrow('yarn channel:slack setup');
  });

  it('is written owner-only by the writer setup shares with yarn mcp:setup', async () => {
    const { writeAuthFile } = await import('../../../../scripts/mcp-local-setup.mjs');
    const path = join(dir, 'channel-slack.env');
    writeAuthFile(path, 'A=1\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the key', () => {
  it('lasts the year yarn mcp:setup gives its own', () => {
    expect(KEY_EXPIRES_IN_DAYS).toBe(365);
  });

  it('is announced in Slack in its last two weeks and once it has expired', () => {
    const now = new Date('2026-11-01T00:00:00.000Z');
    expect(keyExpiryNotice('2027-11-01T00:00:00.000Z', now)).toBeUndefined();
    expect(keyExpiryNotice('2026-11-10T00:00:00.000Z', now)).toContain('expires on 2026-11-10');
    expect(keyExpiryNotice('2026-10-31T00:00:00.000Z', now)).toContain('expired on 2026-10-31');
    expect(keyExpiryNotice(undefined, now)).toBeUndefined();
  });
});
