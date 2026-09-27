import type { ConnectorCatalogEntry } from '@aflow/schemas';

const emailIdParam = {
  name: 'id',
  location: 'path' as const,
  required: true,
  description: 'The email id returned by sendEmail.',
  schema: { type: 'string' },
};

const recipientsSchema = {
  type: 'array',
  description: 'Recipient email addresses (max 50).',
  items: { type: 'string' },
  maxItems: 50,
};

export const RESEND_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'resend',
  version: 2,
  name: 'Resend',
  tagline: 'Send transactional email and manage domains, contacts, and audiences.',
  description:
    'Resend API. Send transactional emails (HTML or text, with cc/bcc/reply-to), read a sent ' +
    "email's delivery status, list verified sending domains, list audiences, and add contacts. " +
    'Authenticated with an API key sent as a bearer token.',
  tags: ['email', 'transactional', 'notifications', 'resend'],
  vendor: 'Resend',
  category: 'communication',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create an API key at resend.com/api-keys (starts with "re_") and verify a sending domain ' +
    'so the "from" address is authorized. The key is sent as Authorization: Bearer <token>.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Resend API key',
      setupNote: 'From resend.com/api-keys (starts with "re_"). Sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'resend',
    name: 'Resend',
    description: 'Resend API — send email, domains, contacts, audiences.',
    baseUrl: 'https://api.resend.com',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
    tags: ['email', 'resend'],
    endpoints: [
      {
        endpointId: 'sendEmail',
        name: 'Send email',
        description:
          'Send a transactional email. Supply html or text (at least one). The "from" address ' +
          'must be on a verified domain.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/emails',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The email to send.',
            schema: {
              type: 'object',
              required: ['from', 'to', 'subject'],
              properties: {
                from: {
                  type: 'string',
                  description:
                    'Sender address on a verified domain, e.g. "Team <team@example.com>".',
                },
                to: recipientsSchema,
                subject: { type: 'string', description: 'The email subject line.' },
                html: {
                  type: 'string',
                  description: 'HTML body. Supply this or text (at least one).',
                },
                text: {
                  type: 'string',
                  description: 'Plain-text body. Supply this or html (at least one).',
                },
                cc: recipientsSchema,
                bcc: recipientsSchema,
                reply_to: {
                  type: 'array',
                  description: 'Reply-To addresses.',
                  items: { type: 'string' },
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['email'],
      },
      {
        endpointId: 'getEmail',
        name: 'Get email',
        description: 'Fetch a sent email by id, including its delivery status and metadata.',
        method: 'GET',
        pathTemplate: '/emails/{id}',
        params: [emailIdParam],
        tags: ['email'],
      },
      {
        endpointId: 'listDomains',
        name: 'List domains',
        description:
          'List the sending domains on the account with their verification status — the source ' +
          'of the verified "from" addresses sendEmail accepts.',
        method: 'GET',
        pathTemplate: '/domains',
        params: [],
        tags: ['domains'],
      },
      {
        endpointId: 'listAudiences',
        name: 'List audiences',
        description:
          'List the contact audiences with their ids — the audienceId createContact needs.',
        method: 'GET',
        pathTemplate: '/audiences',
        params: [],
        tags: ['audiences'],
      },
      {
        endpointId: 'createContact',
        name: 'Create contact',
        description: 'Add a contact to an audience. Resolve the audienceId with listAudiences.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/audiences/{audienceId}/contacts',
        params: [
          {
            name: 'audienceId',
            location: 'path',
            required: true,
            description: 'The audience id (from listAudiences).',
            schema: { type: 'string' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The contact to create.',
            schema: {
              type: 'object',
              required: ['email'],
              properties: {
                email: { type: 'string', description: 'The contact email address.' },
                first_name: { type: 'string', description: 'The contact first name.' },
                last_name: { type: 'string', description: 'The contact last name.' },
                unsubscribed: {
                  type: 'boolean',
                  description: 'Whether the contact is unsubscribed. Default false.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['contacts'],
      },
    ],
  },
};
