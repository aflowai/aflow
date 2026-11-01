/**
 * The channel app's configuration: `~/.aflow/channel-slack.env`, which
 * `yarn channel:slack setup` writes at mode 0600.
 *
 * Read from the file and never from the stack's environment. The stack's
 * `REDIS_URL` carries the password every platform service shares, and this app
 * holds only the channel lane's own credential (Plan 327 D1).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RedisConfig } from '@aflow/redis';
import { z } from 'zod';

export const CHANNEL_SLACK_ENV_FILENAME = 'channel-slack.env';
export const CHANNEL_SLACK_STORE_FILENAME = 'channel-slack.store.json';
/** The Redis identity the platform's ACL gives the channel lane. */
export const CHANNEL_REDIS_USERNAME = 'channelexec';

/** Where the app keeps its file and its store: `~/.aflow`, unless named. */
export function channelSlackDir(env: NodeJS.ProcessEnv = process.env): string {
  const named = env['AFLOW_CHANNEL_SLACK_DIR']?.trim();
  return named !== undefined && named !== '' ? named : join(homedir(), '.aflow');
}

/** `KEY=value` lines, with the single quotes the setup writes around a value. */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    values[match[1]] = match[2].trim().replace(/^'(.*)'$/s, '$1');
  }
  return values;
}

const nonEmpty = z.string().trim().min(1);

export const ChannelSlackConfigSchema = z.object({
  SLACK_BOT_TOKEN: nonEmpty.startsWith('xoxb-', 'SLACK_BOT_TOKEN is a bot token, xoxb-…'),
  SLACK_APP_TOKEN: nonEmpty.startsWith('xapp-', 'SLACK_APP_TOKEN is an app-level token, xapp-…'),
  AFLOW_API_URL: z.string().url(),
  AFLOW_API_KEY: nonEmpty,
  AFLOW_API_KEY_EXPIRES_AT: nonEmpty.optional(),
  AFLOW_TENANT_ID: nonEmpty,
  /** The key's user: the instance owner, the one person this app serves. */
  AFLOW_USER_ID: nonEmpty,
  CHANNEL_REDIS_URL: z.string().regex(/^rediss?:\/\//, 'CHANNEL_REDIS_URL is a redis:// URL'),
  CHANNEL_REDIS_PASSWORD: nonEmpty,
  CHANNEL_SLACK_LINK_CODE_SHA256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  CHANNEL_SLACK_LINK_CODE_EXPIRES_AT: nonEmpty.optional(),
  PHOENIX_PAYLOAD_DIR: nonEmpty.optional(),
});
export type ChannelSlackConfig = z.infer<typeof ChannelSlackConfigSchema>;

export class ChannelSlackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelSlackConfigError';
  }
}

/** The configuration in `dir`, or a refusal that says what to run. */
export function loadChannelSlackConfig(dir: string = channelSlackDir()): ChannelSlackConfig {
  const path = join(dir, CHANNEL_SLACK_ENV_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ChannelSlackConfigError(
      `No channel configuration at ${path}. Run \`yarn channel:slack setup\` with the stack running.`,
    );
  }
  const parsed = ChannelSlackConfigSchema.safeParse(parseEnvText(text));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new ChannelSlackConfigError(
      `${path} is incomplete or malformed (${fields}). Run \`yarn channel:slack setup\` again.`,
    );
  }
  return parsed.data;
}

/**
 * The channel identity's connection. The username and password ride the URL,
 * which is the one form `RedisConfig` carries a username in.
 */
export function channelRedisConfig(config: ChannelSlackConfig): RedisConfig {
  const url = new URL(config.CHANNEL_REDIS_URL);
  url.username = CHANNEL_REDIS_USERNAME;
  url.password = config.CHANNEL_REDIS_PASSWORD;
  return { url: url.toString(), maxRetriesPerRequest: 1 };
}
