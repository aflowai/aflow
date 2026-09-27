import type { ConnectorCatalogEntry } from '@aflow/schemas';

const channelParam = {
  name: 'channel',
  location: 'query' as const,
  required: true,
  description: 'Channel ID (e.g. C0123456789), not the #name — resolve it via conversations.list.',
  schema: { type: 'string' },
};

const cursorParam = {
  name: 'cursor',
  location: 'query' as const,
  required: false,
  description:
    'Pagination cursor from a prior response’s response_metadata.next_cursor. Omit for page one.',
  schema: { type: 'string' },
};

const limitParam = {
  name: 'limit',
  location: 'query' as const,
  required: false,
  description:
    'Maximum items to return per page. Slack recommends 200 or fewer for latency; 1000 is the ' +
    'hard cap. Default 100.',
  schema: { type: 'integer', minimum: 1, maximum: 1000 },
};

export const SLACK_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'slack',
  version: 2,
  name: 'Slack',
  tagline: 'Read channels and message history, look up users, and post messages.',
  description:
    'Slack Web API (method-based, at slack.com/api/<method>). List and read conversations and ' +
    'their message history, look up channels and users, and post a message to a channel or ' +
    'thread. Authenticated with an OAuth 2 bot token obtained through the consent flow — no token ' +
    'is pasted. The requested bot scopes are read-plus-post: channels:read, groups:read (list ' +
    'public + private channels the token can see), channels:history, groups:history (read message ' +
    'history), users:read (resolve user profiles), and chat:write (post messages). This is a ' +
    'deliberately minimal, read-and-post surface — it does not request admin, file, or ' +
    'destructive scopes.',
  tags: ['communication', 'chat', 'messaging', 'slack'],
  vendor: 'Slack',
  category: 'communication',
  honestyLabel: 'curated',
  authKind: 'oauth2_authorization_code',
  oauthIssuerKey: 'slack',
  oauthScopes: [
    'channels:read',
    'groups:read',
    'channels:history',
    'groups:history',
    'users:read',
    'chat:write',
  ],
  setupNote:
    'Register a Slack app at api.slack.com/apps, and under OAuth & Permissions add this platform’s ' +
    'callback as an OAuth redirect URL. Copy the app’s Client ID and Client Secret into this ' +
    'space’s Settings → OAuth Apps, then click Connect and approve the requested scopes in Slack. ' +
    'The token is stored for you — nothing to paste here.',
  definition: {
    apiId: 'slack',
    name: 'Slack',
    description: 'Slack Web API — conversations, history, users, and posting messages.',
    baseUrl: 'https://slack.com/api',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
    tags: ['communication', 'slack'],
    endpoints: [
      {
        endpointId: 'listConversations',
        name: 'List conversations',
        description:
          'List channels (public, private, DMs, group DMs) the token can see. Use it to resolve a ' +
          'channel ID from its name before reading history or posting.',
        method: 'GET',
        pathTemplate: '/conversations.list',
        params: [
          {
            name: 'types',
            location: 'query',
            required: false,
            description:
              'Comma-separated channel types to include: public_channel, private_channel, mpim, im. ' +
              'Default public_channel.',
            schema: { type: 'string' },
          },
          {
            name: 'exclude_archived',
            location: 'query',
            required: false,
            description: 'Set true to omit archived channels.',
            schema: { type: 'boolean' },
          },
          cursorParam,
          limitParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'cursor', limitParam: 'limit' },
        tags: ['conversations'],
      },
      {
        endpointId: 'getConversationInfo',
        name: 'Get conversation info',
        description: 'Fetch metadata for a single channel (name, topic, purpose, membership).',
        method: 'GET',
        pathTemplate: '/conversations.info',
        params: [channelParam],
        tags: ['conversations'],
      },
      {
        endpointId: 'getConversationHistory',
        name: 'Get conversation history',
        description:
          'Fetch a page of messages from a channel, newest first. Page with cursor; narrow with ' +
          'oldest/latest Unix timestamps.',
        method: 'GET',
        pathTemplate: '/conversations.history',
        params: [
          channelParam,
          {
            name: 'oldest',
            location: 'query',
            required: false,
            description: 'Only messages after this Unix timestamp (e.g. "1700000000.000000").',
            schema: { type: 'string' },
          },
          {
            name: 'latest',
            location: 'query',
            required: false,
            description: 'Only messages up to this Unix timestamp.',
            schema: { type: 'string' },
          },
          cursorParam,
          limitParam,
        ],
        pagination: { style: 'cursor', cursorParam: 'cursor', limitParam: 'limit' },
        tags: ['conversations', 'history'],
      },
      {
        endpointId: 'listUsers',
        name: 'List users',
        description: 'List the members of the workspace, with profile and presence metadata.',
        method: 'GET',
        pathTemplate: '/users.list',
        params: [cursorParam, limitParam],
        pagination: { style: 'cursor', cursorParam: 'cursor', limitParam: 'limit' },
        tags: ['users'],
      },
      {
        endpointId: 'getUserInfo',
        name: 'Get user info',
        description: 'Fetch a single user’s profile by user ID (e.g. U0123456789).',
        method: 'GET',
        pathTemplate: '/users.info',
        params: [
          {
            name: 'user',
            location: 'query',
            required: true,
            description: 'The user ID to look up (e.g. U0123456789).',
            schema: { type: 'string' },
          },
        ],
        tags: ['users'],
      },
      {
        endpointId: 'postMessage',
        name: 'Post message',
        description:
          'Post a message to a channel or thread. Send text, or rich layout via blocks (an array of ' +
          'Slack Block Kit blocks). Set thread_ts to reply in a thread.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/chat.postMessage',
        bodyEncoding: 'json',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The message to post.',
            schema: {
              type: 'object',
              required: ['channel'],
              properties: {
                channel: {
                  type: 'string',
                  description:
                    'Channel ID (e.g. C0123456789) or a user ID for a DM. Resolve names via conversations.list.',
                },
                text: {
                  type: 'string',
                  description:
                    'The message text (Slack mrkdwn). Required unless blocks or attachments carry the content; ' +
                    'always include it as the notification/fallback text even when using blocks.',
                },
                thread_ts: {
                  type: 'string',
                  description:
                    'The ts of the parent message to reply under — makes this a threaded reply.',
                },
                reply_broadcast: {
                  type: 'boolean',
                  description:
                    'When replying in a thread, also surface the reply in the channel. Default false.',
                },
                blocks: {
                  type: 'array',
                  description:
                    'Slack Block Kit blocks for rich layout. Each item is a Block Kit block object.',
                  items: { type: 'object', additionalProperties: true },
                },
                mrkdwn: {
                  type: 'boolean',
                  description: 'Whether to render mrkdwn formatting in text. Default true.',
                },
                unfurl_links: {
                  type: 'boolean',
                  description: 'Whether to unfurl links to primarily text-based content.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['messaging'],
      },
    ],
  },
};
