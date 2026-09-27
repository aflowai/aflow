import type { ConnectorCatalogEntry } from '@aflow/schemas';

const messageIdParam = {
  name: 'id',
  location: 'path' as const,
  required: true,
  description: 'The message ID (from listMessages), not the RFC 822 Message-Id header.',
  schema: { type: 'string' },
};

export const GMAIL_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'gmail',
  version: 1,
  name: 'Gmail',
  tagline: 'Read and search mail, send messages, draft, label, and trash.',
  description:
    'Gmail API v1 for the authenticated user ("me"). Search and read messages and their ' +
    'content, list labels, send an email, save a draft, add or remove labels on a message, ' +
    'and move a message to trash. Authenticated with an OAuth 2 token obtained through the ' +
    'Google consent flow — no token is pasted. The requested scopes are gmail.readonly (list, ' +
    'read, labels), gmail.send (send email), and gmail.modify (create draft, label, trash). ' +
    'It requests no admin, settings, or permanent-delete scopes. Gmail scopes are restricted, ' +
    'so the operator’s own Google app must be verified (or in testing mode with the connecting ' +
    'account added as a test user) before consent will grant them.',
  tags: ['communication', 'email', 'mail', 'gmail', 'google'],
  vendor: 'Google',
  category: 'communication',
  honestyLabel: 'curated',
  authKind: 'oauth2_authorization_code',
  oauthIssuerKey: 'google',
  oauthScopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  setupNote:
    'Register an OAuth app in the Google Cloud Console, enable the Gmail API, and add this ' +
    'platform’s callback as an authorized redirect URI. Copy the app’s Client ID and Client ' +
    'Secret into this space’s Settings → OAuth Apps, then click Connect and approve the ' +
    'requested scopes in Google. The token is stored for you — nothing to paste here. NOTE: ' +
    'Gmail scopes are RESTRICTED — Google will not grant them to an unverified app for a ' +
    'general user. Either complete Google’s app verification (a review), or keep the app in ' +
    'testing mode and add the Google account you connect with as a test user; a testing-mode ' +
    'token is granted but expires and is limited to test users.',
  definition: {
    apiId: 'gmail',
    name: 'Gmail',
    description: 'Gmail API v1 — read, search, send, draft, label, and trash mail for "me".',
    baseUrl: 'https://gmail.googleapis.com/gmail/v1',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
    tags: ['communication', 'gmail'],
    endpoints: [
      {
        endpointId: 'listMessages',
        name: 'List messages',
        description:
          'List message IDs in the mailbox, newest first. Narrow with a Gmail search query ' +
          '(q) — the same operators as the Gmail search box (e.g. "from:alice is:unread ' +
          'newer_than:7d"). Returns IDs and thread IDs; fetch content with getMessage.',
        method: 'GET',
        pathTemplate: '/users/me/messages',
        params: [
          {
            name: 'q',
            location: 'query',
            required: false,
            description:
              'Gmail search query using the standard search operators (e.g. ' +
              '"from:alice@example.com is:unread subject:invoice").',
            schema: { type: 'string' },
          },
          {
            name: 'labelIds',
            location: 'query',
            required: false,
            description:
              'Only return messages carrying every one of these label IDs (e.g. INBOX, UNREAD). ' +
              'Repeat the parameter to require more than one.',
            schema: { type: 'string' },
          },
          {
            name: 'maxResults',
            location: 'query',
            required: false,
            description: 'Maximum message IDs to return per page (Gmail default 100, cap 500).',
            schema: { type: 'integer', minimum: 1, maximum: 500 },
          },
          {
            name: 'pageToken',
            location: 'query',
            required: false,
            description:
              'Pagination token from a prior response’s nextPageToken. Omit for page one.',
            schema: { type: 'string' },
          },
        ],
        pagination: { style: 'cursor', cursorParam: 'pageToken', limitParam: 'maxResults' },
        tags: ['messages'],
      },
      {
        endpointId: 'getMessage',
        name: 'Get message',
        description:
          'Fetch a single message by ID. Use format to control how much is returned: full (the ' +
          'default — headers and parsed body parts), metadata (headers only), minimal (IDs and ' +
          'labels), or raw (the base64url-encoded RFC 2822 source).',
        method: 'GET',
        pathTemplate: '/users/me/messages/{id}',
        params: [
          messageIdParam,
          {
            name: 'format',
            location: 'query',
            required: false,
            description:
              'How much of the message to return: "full" (default), "metadata", "minimal", or "raw".',
            schema: { type: 'string' },
          },
        ],
        tags: ['messages'],
      },
      {
        endpointId: 'sendMessage',
        name: 'Send message',
        description:
          'Send an email as the authenticated user. The body carries the entire message as a ' +
          'base64url-encoded RFC 2822 string in "raw" (build the MIME message with To/Subject/' +
          'body headers, then base64url-encode it). Set threadId to send the message as a reply ' +
          'within an existing thread. This delivers external email — it is gated for approval.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/users/me/messages/send',
        bodyEncoding: 'json',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The message to send.',
            schema: {
              type: 'object',
              required: ['raw'],
              properties: {
                raw: {
                  type: 'string',
                  description:
                    'The entire email as a base64url-encoded RFC 2822 message (headers plus ' +
                    'body). This is the MIME source, not plain text.',
                },
                threadId: {
                  type: 'string',
                  description:
                    'Send this message into an existing thread (must match a thread the ' +
                    'referenced In-Reply-To/References headers belong to). Omit to start a new thread.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['messages', 'send'],
      },
      {
        endpointId: 'createDraft',
        name: 'Create draft',
        description:
          'Save an email as a draft without sending it. The draft’s message carries the same ' +
          'base64url-encoded RFC 2822 "raw" string as a send. A draft is not delivered until ' +
          'separately sent.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/users/me/drafts',
        bodyEncoding: 'json',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The draft to create.',
            schema: {
              type: 'object',
              required: ['message'],
              properties: {
                message: {
                  type: 'object',
                  description: 'The draft’s message.',
                  required: ['raw'],
                  properties: {
                    raw: {
                      type: 'string',
                      description:
                        'The entire email as a base64url-encoded RFC 2822 message (headers plus body).',
                    },
                    threadId: {
                      type: 'string',
                      description:
                        'Attach the draft to an existing thread. Omit to start a new one.',
                    },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['drafts'],
      },
      {
        endpointId: 'listLabels',
        name: 'List labels',
        description:
          'List the labels in the mailbox — the system labels (INBOX, SENT, UNREAD, …) and any ' +
          'user-created labels, with their IDs. Use the IDs with listMessages and modifyMessage.',
        method: 'GET',
        pathTemplate: '/users/me/labels',
        params: [],
        tags: ['labels'],
      },
      {
        endpointId: 'modifyMessage',
        name: 'Modify message labels',
        description:
          'Add or remove labels on a message by ID — e.g. mark read (remove UNREAD), archive ' +
          '(remove INBOX), or apply a user label. Reversible: re-applying or re-removing the ' +
          'label undoes it.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/users/me/messages/{id}/modify',
        bodyEncoding: 'json',
        params: [
          messageIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The labels to add and/or remove.',
            schema: {
              type: 'object',
              properties: {
                addLabelIds: {
                  type: 'array',
                  description: 'Label IDs to add to the message (e.g. ["STARRED"]).',
                  items: { type: 'string' },
                },
                removeLabelIds: {
                  type: 'array',
                  description: 'Label IDs to remove from the message (e.g. ["UNREAD", "INBOX"]).',
                  items: { type: 'string' },
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['messages', 'labels'],
      },
      {
        endpointId: 'trashMessage',
        name: 'Trash message',
        description:
          'Move a message to the trash by ID. This removes it from the inbox and other views; ' +
          'it is a soft-delete (Gmail purges trash after ~30 days) and can be restored with ' +
          'untrash, but it is not a plain label change.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/users/me/messages/{id}/trash',
        params: [messageIdParam],
        tags: ['messages'],
      },
    ],
  },
};
