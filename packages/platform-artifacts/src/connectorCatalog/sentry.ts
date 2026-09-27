import type { ConnectorCatalogEntry } from '@aflow/schemas';

const organizationSlugParam = {
  name: 'organization_id_or_slug',
  location: 'path' as const,
  required: true,
  description: 'The id or slug of the organization the issue or release belongs to.',
  schema: { type: 'string' },
};

const issueIdParam = {
  name: 'issue_id',
  location: 'path' as const,
  required: true,
  description: 'The id of the issue (a group id, e.g. from listOrganizationIssues).',
  schema: { type: 'string' },
};

export const SENTRY_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'sentry',
  version: 1,
  name: 'Sentry',
  tagline: 'Triage errors: list and update issues, inspect events, and track releases.',
  description:
    'Sentry API (SaaS sentry.io). List projects, browse an organization’s issues with a ' +
    'structured search query, read a single issue and its events, resolve/ignore/assign an ' +
    'issue, delete an issue, list releases, and record a new release. Authenticated with an ' +
    'auth token sent as a bearer token. Self-hosted Sentry uses a different base URL and is not ' +
    'covered by this curated connector.',
  tags: ['errors', 'monitoring', 'observability', 'issues', 'sentry'],
  vendor: 'Sentry',
  category: 'developer-tools',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create an auth token in Sentry at Settings → Auth Tokens (a user auth token or an internal ' +
    'integration token). It is sent as Authorization: Bearer <token>.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Sentry auth token',
      setupNote:
        'From sentry.io → Settings → Auth Tokens (a user auth token or an internal integration ' +
        'token). Sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'sentry',
    name: 'Sentry',
    description: 'Sentry API — projects, issues, events, releases.',
    baseUrl: 'https://sentry.io/api/0',
    version: '0',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'] },
    tags: ['errors', 'sentry'],
    endpoints: [
      {
        endpointId: 'listProjects',
        name: 'List projects',
        description:
          'List the projects the authenticated token has access to, across organizations — the ' +
          'source of the organization and project slugs the other endpoints need.',
        method: 'GET',
        pathTemplate: '/projects/',
        params: [],
        tags: ['projects'],
      },
      {
        endpointId: 'listOrganizationIssues',
        name: 'List organization issues',
        description:
          'List an organization’s issues, optionally narrowed by a Sentry structured search ' +
          'query and a stats period. Returns issue ids for getIssue / updateIssue.',
        method: 'GET',
        pathTemplate: '/organizations/{organization_id_or_slug}/issues/',
        params: [
          organizationSlugParam,
          {
            name: 'query',
            location: 'query',
            required: false,
            description:
              'A Sentry structured search query, e.g. "is:unresolved". Omit for the default view.',
            schema: { type: 'string' },
          },
          {
            name: 'statsPeriod',
            location: 'query',
            required: false,
            description: 'The stats period to scope the issue list to, e.g. "24h" or "14d".',
            schema: { type: 'string' },
          },
        ],
        tags: ['issues'],
      },
      {
        endpointId: 'getIssue',
        name: 'Get issue',
        description: 'Retrieve a single issue by id, including its status, culprit, and metadata.',
        method: 'GET',
        pathTemplate: '/organizations/{organization_id_or_slug}/issues/{issue_id}/',
        params: [organizationSlugParam, issueIdParam],
        tags: ['issues'],
      },
      {
        endpointId: 'updateIssue',
        name: 'Update issue',
        description:
          'Update an issue — resolve, ignore/mute, or assign it, or toggle its bookmark/seen ' +
          'state. Internal triage on your own project; reversible.',
        method: 'PUT',
        writeRiskTier: 'low',
        pathTemplate: '/organizations/{organization_id_or_slug}/issues/{issue_id}/',
        params: [
          organizationSlugParam,
          issueIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The fields to update on the issue.',
            schema: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  description: 'The new status for the issue.',
                  enum: ['resolved', 'unresolved', 'ignored', 'resolvedInNextRelease', 'muted'],
                },
                assignedTo: {
                  type: 'string',
                  description:
                    'Actor to assign the issue to, e.g. "<email>", "user:<user_id>", or ' +
                    '"team:<team_id>". Empty string clears the assignee.',
                },
                isPublic: {
                  type: 'boolean',
                  description: 'Whether the issue is publicly shareable.',
                },
                isBookmarked: {
                  type: 'boolean',
                  description: 'Whether the requestor bookmarks the issue.',
                },
                isSubscribed: {
                  type: 'boolean',
                  description: 'Whether the requestor subscribes to the issue.',
                },
                hasSeen: {
                  type: 'boolean',
                  description: 'Marks the issue as seen by the requestor.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['issues'],
      },
      {
        endpointId: 'deleteIssue',
        name: 'Delete issue',
        description:
          'Permanently remove an issue and its aggregated events. Not easily undone — the issue ' +
          'and its history are gone.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/organizations/{organization_id_or_slug}/issues/{issue_id}/',
        params: [organizationSlugParam, issueIdParam],
        tags: ['issues'],
      },
      {
        endpointId: 'listIssueEvents',
        name: 'List issue events',
        description:
          'List the individual error events bound to an issue — the concrete occurrences behind ' +
          'the aggregated issue.',
        method: 'GET',
        pathTemplate: '/organizations/{organization_id_or_slug}/issues/{issue_id}/events/',
        params: [organizationSlugParam, issueIdParam],
        tags: ['issues', 'events'],
      },
      {
        endpointId: 'listReleases',
        name: 'List releases',
        description:
          'List an organization’s releases, optionally narrowed by a case-insensitive substring ' +
          'match against the release version.',
        method: 'GET',
        pathTemplate: '/organizations/{organization_id_or_slug}/releases/',
        params: [
          organizationSlugParam,
          {
            name: 'query',
            location: 'query',
            required: false,
            description: 'Case-insensitive substring match against the release version.',
            schema: { type: 'string' },
          },
        ],
        tags: ['releases'],
      },
      {
        endpointId: 'createRelease',
        name: 'Create release',
        description:
          'Record a new release for an organization, associating it with one or more projects. ' +
          'Internal bookkeeping; reversible.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/organizations/{organization_id_or_slug}/releases/',
        params: [
          organizationSlugParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The release to create.',
            schema: {
              type: 'object',
              required: ['version', 'projects'],
              properties: {
                version: {
                  type: 'string',
                  description:
                    'A version identifier for the release — a version number, a commit hash, etc.',
                },
                projects: {
                  type: 'array',
                  description: 'The project slugs involved in this release.',
                  items: { type: 'string' },
                },
                ref: {
                  type: 'string',
                  description: 'An optional commit reference for the tagged version.',
                },
                url: {
                  type: 'string',
                  description: 'An optional URL pointing to the release, e.g. a repository link.',
                },
                dateReleased: {
                  type: 'string',
                  description:
                    'An optional ISO-8601 date the release went live. Defaults to now if omitted.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['releases'],
      },
    ],
  },
};
