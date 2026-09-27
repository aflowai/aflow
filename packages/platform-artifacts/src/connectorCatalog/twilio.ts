import type { ConnectorCatalogEntry } from '@aflow/schemas';

const pageSizeParam = {
  name: 'PageSize',
  location: 'query' as const,
  required: false,
  description: 'Number of resources to return per page (max 1000, default 50).',
  schema: { type: 'integer', minimum: 1, maximum: 1000 },
};

export const TWILIO_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'twilio',
  version: 2,
  name: 'Twilio',
  tagline: 'Send SMS, place calls, and read message and call logs.',
  description:
    'Twilio REST API (2010-04-01). Send an SMS, list and read message logs, place an outbound ' +
    'call, and list call logs. Writes are form-encoded (application/x-www-form-urlencoded). ' +
    'Authenticated with HTTP basic auth — the Account SID is the username and the Auth Token is ' +
    'the password.',
  tags: ['sms', 'voice', 'messaging', 'telephony', 'twilio'],
  vendor: 'Twilio',
  category: 'communication',
  honestyLabel: 'curated',
  authKind: 'basic',
  setupNote:
    'Enter your Twilio Account SID (Console dashboard; starts with "AC") in TWO places: as the ' +
    'non-secret accountSid variable (it is part of the request path) AND as the basic-auth ' +
    'username. Enter your Auth Token (Console dashboard) as the basic-auth password. The SID is ' +
    'not a secret and appears in URLs and logs; the Auth Token is the secret.',
  credentialPrompts: [
    {
      authField: 'usernameCredentialKey',
      label: 'Account SID (basic-auth username)',
      setupNote:
        'From the Twilio Console dashboard (starts with "AC"). Used as the HTTP basic-auth username. Also set it as the accountSid variable.',
    },
    {
      authField: 'passwordCredentialKey',
      label: 'Auth Token (basic-auth password)',
      setupNote:
        'From the Twilio Console dashboard. The secret — used as the HTTP basic-auth password.',
    },
  ],
  definition: {
    apiId: 'twilio',
    name: 'Twilio',
    description: 'Twilio REST API (2010-04-01) — messages and calls.',
    baseUrlTemplate: 'https://api.twilio.com/2010-04-01/Accounts/{accountSid}',
    variables: [
      {
        name: 'accountSid',
        description:
          'Your Twilio Account SID (starts with "AC") — it is part of the request path. This is ' +
          'the same value as the basic-auth username; set it in both places. Non-secret.',
        example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        required: true,
      },
    ],
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
    tags: ['messaging', 'twilio'],
    endpoints: [
      {
        endpointId: 'sendSms',
        name: 'Send SMS',
        description:
          'Send an SMS (or MMS) message. Form-encoded. From must be a Twilio number you own (or a ' +
          'Messaging Service SID); To is E.164 (e.g. +14155551234).',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/Messages.json',
        bodyEncoding: 'form-urlencoded',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The message fields (form-encoded).',
            schema: {
              type: 'object',
              required: ['To', 'From', 'Body'],
              properties: {
                To: {
                  type: 'string',
                  description: 'Destination phone number in E.164 format, e.g. "+14155551234".',
                },
                From: {
                  type: 'string',
                  description:
                    'A Twilio phone number you own in E.164 format (or a Messaging Service SID, "MG...").',
                },
                Body: {
                  type: 'string',
                  description: 'The text of the message (up to 1600 characters).',
                },
                MediaUrl: {
                  type: 'string',
                  description: 'Publicly reachable URL of an image or media file to send as MMS.',
                },
                StatusCallback: {
                  type: 'string',
                  description: 'URL Twilio POSTs delivery-status updates to.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['messages'],
      },
      {
        endpointId: 'listMessages',
        name: 'List messages',
        description:
          'List messages in the account log, most recent first. Filter by the To or From number ' +
          'or by the date sent.',
        method: 'GET',
        pathTemplate: '/Messages.json',
        params: [
          {
            name: 'To',
            location: 'query',
            required: false,
            description: 'Return only messages sent to this E.164 number.',
            schema: { type: 'string' },
          },
          {
            name: 'From',
            location: 'query',
            required: false,
            description: 'Return only messages sent from this E.164 number.',
            schema: { type: 'string' },
          },
          {
            name: 'DateSent',
            location: 'query',
            required: false,
            description: 'Return only messages sent on this date (YYYY-MM-DD).',
            schema: { type: 'string' },
          },
          pageSizeParam,
        ],
        tags: ['messages'],
      },
      {
        endpointId: 'getMessage',
        name: 'Get message',
        description: 'Fetch a single message by its SID, including status and error details.',
        method: 'GET',
        pathTemplate: '/Messages/{MessageSid}.json',
        params: [
          {
            name: 'MessageSid',
            location: 'path',
            required: true,
            description: 'The message SID (starts with "SM" or "MM").',
            schema: { type: 'string' },
          },
        ],
        tags: ['messages'],
      },
      {
        endpointId: 'makeCall',
        name: 'Make call',
        description:
          'Place an outbound call. Form-encoded. Supply exactly one of Url (a TwiML URL Twilio ' +
          'fetches when the call connects) or Twiml (inline TwiML instructions).',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/Calls.json',
        bodyEncoding: 'form-urlencoded',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The call fields (form-encoded).',
            schema: {
              type: 'object',
              required: ['To', 'From'],
              properties: {
                To: {
                  type: 'string',
                  description: 'Destination phone number in E.164 format, e.g. "+14155551234".',
                },
                From: {
                  type: 'string',
                  description: 'A Twilio phone number you own in E.164 format.',
                },
                Url: {
                  type: 'string',
                  description:
                    'A publicly reachable URL returning TwiML that controls the call. Set this OR Twiml.',
                },
                Twiml: {
                  type: 'string',
                  description:
                    'Inline TwiML controlling the call, e.g. "<Response><Say>Hello</Say></Response>". Set this OR Url.',
                },
                StatusCallback: {
                  type: 'string',
                  description: 'URL Twilio POSTs call-progress events to.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['calls'],
      },
      {
        endpointId: 'listCalls',
        name: 'List calls',
        description:
          'List calls in the account log, most recent first. Filter by the To or From number, by ' +
          'status, or by the start date.',
        method: 'GET',
        pathTemplate: '/Calls.json',
        params: [
          {
            name: 'To',
            location: 'query',
            required: false,
            description: 'Return only calls to this E.164 number.',
            schema: { type: 'string' },
          },
          {
            name: 'From',
            location: 'query',
            required: false,
            description: 'Return only calls from this E.164 number.',
            schema: { type: 'string' },
          },
          {
            name: 'Status',
            location: 'query',
            required: false,
            description: 'Filter by call status.',
            schema: {
              type: 'string',
              enum: [
                'queued',
                'ringing',
                'in-progress',
                'completed',
                'busy',
                'failed',
                'no-answer',
                'canceled',
              ],
            },
          },
          {
            name: 'StartTime',
            location: 'query',
            required: false,
            description: 'Return only calls that started on this date (YYYY-MM-DD).',
            schema: { type: 'string' },
          },
          pageSizeParam,
        ],
        tags: ['calls'],
      },
    ],
  },
};
