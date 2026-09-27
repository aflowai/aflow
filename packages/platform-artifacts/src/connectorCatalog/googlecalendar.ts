import type { ConnectorCatalogEntry } from '@aflow/schemas';

const calendarIdParam = {
  name: 'calendarId',
  location: 'path' as const,
  required: true,
  description:
    'Calendar identifier. Use "primary" for the authenticated user’s main calendar, or a ' +
    'calendar id from listCalendars.',
  schema: { type: 'string' },
};

const eventIdParam = {
  name: 'eventId',
  location: 'path' as const,
  required: true,
  description: 'Event identifier, from listEvents or the response of createEvent.',
  schema: { type: 'string' },
};

const sendUpdatesParam = {
  name: 'sendUpdates',
  location: 'query' as const,
  required: false,
  description:
    'Who should receive email notifications about this change: "all" (every guest), ' +
    '"externalOnly" (non-Google Calendar guests only), or "none" (default — no notifications). ' +
    'Sends real email to attendees when set to all/externalOnly.',
  schema: { type: 'string', enum: ['all', 'externalOnly', 'none'] },
};

const eventDateTimeSchema = {
  type: 'object',
  description:
    'A point in time for the event boundary. Use dateTime for a timed event, or date for an ' +
    'all-day event — exactly one of the two.',
  properties: {
    dateTime: {
      type: 'string',
      description: 'RFC3339 timestamp for a timed event (e.g. "2026-08-01T10:00:00-07:00").',
    },
    date: {
      type: 'string',
      description: 'Calendar date "yyyy-mm-dd" for an all-day event.',
    },
    timeZone: {
      type: 'string',
      description:
        'IANA time zone name (e.g. "Europe/Berlin"). Required when dateTime carries no offset ' +
        'and for recurring events.',
    },
  },
  additionalProperties: false,
};

const attendeesSchema = {
  type: 'array',
  description: 'The event’s guests. Adding a guest here can email them an invitation.',
  items: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', description: 'The attendee’s email address (RFC5322).' },
      displayName: { type: 'string', description: 'The attendee’s name, if known.' },
      optional: {
        type: 'boolean',
        description: 'Whether attendance is optional. Default false.',
      },
    },
    additionalProperties: false,
  },
};

const eventBodySchema = {
  type: 'object',
  required: ['start', 'end'],
  properties: {
    summary: { type: 'string', description: 'The event title.' },
    description: { type: 'string', description: 'Free-form event description; may contain HTML.' },
    location: { type: 'string', description: 'Free-form geographic location of the event.' },
    start: eventDateTimeSchema,
    end: eventDateTimeSchema,
    attendees: attendeesSchema,
  },
  additionalProperties: false,
};

export const GOOGLE_CALENDAR_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'google-calendar',
  version: 1,
  name: 'Google Calendar',
  tagline: 'List calendars, read and search events, and create, update, or delete events.',
  description:
    'Google Calendar API v3. List the calendars the account can see, list and search events on a ' +
    'calendar, read a single event, and create, update, or delete events. Authenticated with an ' +
    'OAuth 2 token obtained through the Google consent flow — no token is pasted. The single ' +
    'requested scope (https://www.googleapis.com/auth/calendar) covers reading and writing events ' +
    'and calendars. Create, update, and delete can email attendees when their sendUpdates ' +
    'parameter is set.',
  tags: ['calendar', 'scheduling', 'events', 'google', 'productivity'],
  vendor: 'Google',
  category: 'productivity',
  honestyLabel: 'curated',
  authKind: 'oauth2_authorization_code',
  oauthIssuerKey: 'google',
  oauthScopes: ['https://www.googleapis.com/auth/calendar'],
  setupNote:
    'Register an OAuth app in the Google Cloud Console, enable the Google Calendar API, and add ' +
    'this platform’s callback as an authorized redirect URI. Copy the app’s Client ID and Client ' +
    'Secret into this space’s Settings → OAuth Apps, then click Connect and approve access in ' +
    'Google. Your Google app must have the Calendar scope configured on its OAuth consent screen ' +
    '— it is a sensitive scope, so the app needs to be verified or in testing mode with your ' +
    'account added as a test user. The token is stored for you — nothing to paste here.',
  definition: {
    apiId: 'google-calendar',
    name: 'Google Calendar',
    description: 'Google Calendar API v3 — calendars and events.',
    baseUrl: 'https://www.googleapis.com/calendar/v3',
    version: '3',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'] },
    tags: ['calendar', 'google'],
    endpoints: [
      {
        endpointId: 'listCalendars',
        name: 'List calendars',
        description:
          'List the calendars on the user’s calendar list. Use it to resolve a calendarId before ' +
          'reading or writing events.',
        method: 'GET',
        pathTemplate: '/users/me/calendarList',
        params: [],
        tags: ['calendars'],
      },
      {
        endpointId: 'listEvents',
        name: 'List events',
        description:
          'List events on a calendar, optionally filtered by time window and free-text query. ' +
          'Set singleEvents=true and orderBy=startTime to expand recurring events into instances.',
        method: 'GET',
        pathTemplate: '/calendars/{calendarId}/events',
        params: [
          calendarIdParam,
          {
            name: 'timeMin',
            location: 'query',
            required: false,
            description:
              'Lower bound (inclusive) for an event’s end time, as an RFC3339 timestamp with ' +
              'offset (e.g. "2026-08-01T00:00:00Z").',
            schema: { type: 'string' },
          },
          {
            name: 'timeMax',
            location: 'query',
            required: false,
            description:
              'Upper bound (exclusive) for an event’s start time, as an RFC3339 timestamp with ' +
              'offset.',
            schema: { type: 'string' },
          },
          {
            name: 'q',
            location: 'query',
            required: false,
            description: 'Free-text search over event fields (summary, description, location, …).',
            schema: { type: 'string' },
          },
          {
            name: 'singleEvents',
            location: 'query',
            required: false,
            description:
              'Expand recurring events into individual instances. Required to be true when ' +
              'orderBy is startTime.',
            schema: { type: 'boolean' },
          },
          {
            name: 'orderBy',
            location: 'query',
            required: false,
            description:
              'Order of returned events: "startTime" (requires singleEvents) or "updated".',
            schema: { type: 'string', enum: ['startTime', 'updated'] },
          },
        ],
        tags: ['events'],
      },
      {
        endpointId: 'getEvent',
        name: 'Get event',
        description: 'Fetch a single event by id from a calendar.',
        method: 'GET',
        pathTemplate: '/calendars/{calendarId}/events/{eventId}',
        params: [calendarIdParam, eventIdParam],
        tags: ['events'],
      },
      {
        endpointId: 'createEvent',
        name: 'Create event',
        description:
          'Create an event on a calendar. Set sendUpdates to email the attendees; omit it to ' +
          'create the event without notifying anyone.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/calendars/{calendarId}/events',
        bodyEncoding: 'json',
        params: [
          calendarIdParam,
          sendUpdatesParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The event to create.',
            schema: eventBodySchema,
          },
        ],
        tags: ['events'],
      },
      {
        endpointId: 'updateEvent',
        name: 'Update event',
        description:
          'Replace an existing event by id. Set sendUpdates to email attendees about the change.',
        method: 'PUT',
        writeRiskTier: 'low',
        pathTemplate: '/calendars/{calendarId}/events/{eventId}',
        bodyEncoding: 'json',
        params: [
          calendarIdParam,
          eventIdParam,
          sendUpdatesParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The full event resource to write.',
            schema: eventBodySchema,
          },
        ],
        tags: ['events'],
      },
      {
        endpointId: 'deleteEvent',
        name: 'Delete event',
        description:
          'Delete an event by id from a calendar. Set sendUpdates to notify attendees of the ' +
          'cancellation. Not easily undone.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/calendars/{calendarId}/events/{eventId}',
        params: [calendarIdParam, eventIdParam, sendUpdatesParam],
        tags: ['events'],
      },
    ],
  },
};
