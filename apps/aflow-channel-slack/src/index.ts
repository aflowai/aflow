/**
 * The Slack channel app (Plan 327): the channel lane's executor and its Slack
 * listener in one process.
 *
 * It claims `aflow:jobs:channel` as its own Redis identity, which reaches that
 * stream and the executor runtime's families and nothing else, and it reaches
 * Slack over Socket Mode, which needs no public URL. Nothing in the platform
 * imports it; deleting this workspace removes the lane.
 */
import { join } from 'node:path';

import {
  DEFAULT_EXECUTOR_CONFIG,
  ExecutorRuntime,
  createServiceLogger,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import { attachSignalHandlers, createShutdownController } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import {
  attachRedisErrorGuard,
  closeRedisConnection,
  createBlockingRedisConnection,
  getRedisConnection,
  quitRedisWithTimeout,
} from '@aflow/redis';
import { StreamKeys } from '@aflow/schemas';

import {
  CHANNEL_SLACK_STORE_FILENAME,
  channelRedisConfig,
  channelSlackDir,
  loadChannelSlackConfig,
} from './config.js';
import { createAflowApi } from './aflowApi.js';
import { Conversations, type WatchOutcome } from './conversation.js';
import { answerInbound, answerTap } from './inbound.js';
import { keyExpiryNotice } from './keyExpiry.js';
import { ChannelMessageSendHandler } from './sendHandler.js';
import { createSlackClient } from './slack.js';
import { startSocketMode } from './socketMode.js';
import { ChannelStore } from './store.js';

const log = createServiceLogger('channel-slack');

async function main(): Promise<void> {
  const dir = channelSlackDir();
  const config = loadChannelSlackConfig(dir);
  const store = ChannelStore.open(join(dir, CHANNEL_SLACK_STORE_FILENAME));
  const slack = createSlackClient({
    botToken: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
  });

  const redisConfig = channelRedisConfig(config);
  const redis = getRedisConnection(redisConfig);
  const redisBlocking = createBlockingRedisConnection('channel-slack-blocking', redisConfig);

  const payloadEnv: NodeJS.ProcessEnv =
    config.PHOENIX_PAYLOAD_DIR === undefined
      ? {}
      : { PHOENIX_PAYLOAD_DIR: config.PHOENIX_PAYLOAD_DIR };
  const resolved = resolvePayloadStore({ redis, allowMemory: false, env: payloadEnv });
  if (resolved === null) {
    throw new Error(
      'No payload store resolves for the channel app; run `yarn channel:slack setup` again.',
    );
  }

  const deps: ExecutorDependencies = { redis, redisBlocking, payloadStore: resolved.store };
  const hostname = process.env['HOSTNAME'] ?? `channel-slack-${String(process.pid)}`;
  const runtime = new ExecutorRuntime(
    {
      ...DEFAULT_EXECUTOR_CONFIG,
      consumerName: `${hostname}-channel`,
      consumerGroup: 'exec_channel',
      streamKey: StreamKeys.jobStream('channel'),
      stepType: 'channel',
      concurrency: 4,
      defaultTimeoutMs: 30_000,
    },
    deps,
  );
  // The owner's key from setup: the app reads and resolves items with it, and holds the operator's conversations.
  const api = createAflowApi({
    apiUrl: config.AFLOW_API_URL,
    apiKey: config.AFLOW_API_KEY,
    fetchImpl: fetch,
  });
  runtime.registerHandler(new ChannelMessageSendHandler({ store, slack, api }));
  await runtime.start();

  const conversations = new Conversations({ store, slack, api, aflowUserId: config.AFLOW_USER_ID });
  const watched = (watching: Promise<WatchOutcome> | undefined): void => {
    watching?.catch((error: unknown) => {
      log.warn('Stopped watching a conversation for its answer', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  for (const watching of conversations.resumeWatching()) watched(watching);

  const socket = startSocketMode({
    slack,
    log,
    onDirectMessage: async (message) => {
      const result = await answerInbound(message, { store, slack, api, config, conversations });
      if (result.outcome === 'linked') log.info('Linked the Slack user who sent the setup code');
      if ('watching' in result) watched(result.watching);
    },
    onCardTap: async (tap) => {
      const result = await answerTap(tap, { store, slack, api, conversations });
      if (typeof result === 'string') {
        log.info('Answered a tap on a card', { outcome: result });
        return;
      }
      log.info('Answered a tap on a late message', { outcome: result.outcome });
      watched(result.watching);
    },
  });

  const link = store.link();
  log.info('Channel app started', { linked: link !== null, payloadStore: resolved.reason });
  const notice = keyExpiryNotice(config.AFLOW_API_KEY_EXPIRES_AT, new Date());
  if (notice !== undefined && link !== null) {
    await slack
      .openDirectMessage(link.slackUserId)
      .then((channel) => slack.postMessage(channel, notice))
      .catch((error: unknown) => {
        log.warn('Could not tell the operator the key expires', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  const controller = createShutdownController({
    name: 'Channel app',
    logger: log,
    onShutdown: async () => {
      socket.stop();
      await runtime.stop();
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
    },
  });
  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });
}

main().catch((error: unknown) => {
  log.error('Failed to start the channel app', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
