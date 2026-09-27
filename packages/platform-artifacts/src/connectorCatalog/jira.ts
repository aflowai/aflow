import type { ConnectorCatalogEntry } from '@aflow/schemas';

const startAtParam = {
  name: 'startAt',
  location: 'query' as const,
  required: false,
  description: 'Zero-based index of the first item to return (pagination offset).',
  schema: { type: 'integer', minimum: 0 },
};

const maxResultsParam = {
  name: 'maxResults',
  location: 'query' as const,
  required: false,
  description: 'Maximum number of items to return per page.',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
};

const jqlParam = {
  name: 'jql',
  location: 'query' as const,
  required: false,
  description: 'JQL query string used to filter issues.',
  schema: { type: 'string' },
};

const nextPageTokenParam = {
  name: 'nextPageToken',
  location: 'query' as const,
  required: false,
  description:
    'Cursor token for the next page, taken from the previous response\'s "nextPageToken". Omit for the first page.',
  schema: { type: 'string' },
};

const fieldsParam = {
  name: 'fields',
  location: 'query' as const,
  required: false,
  description: 'Comma-separated list of fields to return for each issue.',
  schema: { type: 'string' },
};

export const JIRA_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'jira-cloud',
  version: 2,
  name: 'Jira Cloud',
  tagline: 'Read and manage Jira issues, boards, and projects.',
  description:
    'Atlassian Jira Cloud REST + Agile API. Search and read issues, list projects and ' +
    'boards, create and update issues, move issues through workflow transitions, and add ' +
    'comments. Authenticated with your Atlassian account email and an API token.',
  tags: ['issue-tracking', 'project-management', 'atlassian', 'agile'],
  vendor: 'Atlassian',
  category: 'project-management',
  honestyLabel: 'curated',
  authKind: 'basic',
  setupNote:
    'Enter your Jira Cloud site subdomain (the part before .atlassian.net), your Atlassian ' +
    'account email as the username, and an API token (Atlassian account settings → Security → ' +
    'Create and manage API tokens) as the password.',
  credentialPrompts: [
    {
      authField: 'usernameCredentialKey',
      label: 'Atlassian account email',
      setupNote: 'The email address of the Atlassian account whose API token you are using.',
    },
    {
      authField: 'passwordCredentialKey',
      label: 'API token',
      setupNote:
        'Create at id.atlassian.com → Security → API tokens. Used as the password in HTTP basic auth.',
    },
  ],
  definition: {
    apiId: 'jira-cloud',
    name: 'Jira Cloud',
    description: 'Atlassian Jira Cloud REST + Agile API.',
    baseUrlTemplate: 'https://{domain}.atlassian.net',
    variables: [
      {
        name: 'domain',
        description:
          'Your Jira Cloud site subdomain — the part before ".atlassian.net" in your site URL.',
        example: 'acme',
        required: true,
      },
    ],
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    tags: ['issue-tracking', 'atlassian'],
    endpoints: [
      {
        endpointId: 'listProjects',
        name: 'List projects',
        description: 'Paginated list of projects visible to the authenticated user.',
        method: 'GET',
        pathTemplate: '/rest/api/3/project/search',
        params: [startAtParam, maxResultsParam],
        tags: ['projects'],
      },
      {
        endpointId: 'listBoards',
        name: 'List boards',
        description: 'Paginated list of agile boards, optionally filtered by project.',
        method: 'GET',
        pathTemplate: '/rest/agile/1.0/board',
        params: [
          startAtParam,
          maxResultsParam,
          {
            name: 'projectKeyOrId',
            location: 'query',
            required: false,
            description: 'Filter boards to those associated with this project key or id.',
            schema: { type: 'string' },
          },
        ],
        tags: ['boards', 'agile'],
      },
      {
        endpointId: 'listBoardIssues',
        name: 'List board issues',
        description: 'Issues on a board, optionally filtered with JQL.',
        method: 'GET',
        pathTemplate: '/rest/agile/1.0/board/{boardId}/issue',
        params: [
          {
            name: 'boardId',
            location: 'path',
            required: true,
            description: 'The id of the board.',
            schema: { type: 'integer' },
          },
          jqlParam,
          startAtParam,
          maxResultsParam,
        ],
        tags: ['boards', 'issues', 'agile'],
      },
      {
        endpointId: 'searchIssuesJql',
        name: 'Search issues (JQL)',
        description:
          'Search for issues across projects using a JQL query. Cursor-paginated: pass the ' +
          'previous response\'s "nextPageToken" to fetch the next page (no total is returned).',
        method: 'GET',
        pathTemplate: '/rest/api/3/search/jql',
        params: [jqlParam, nextPageTokenParam, maxResultsParam, fieldsParam],
        pagination: { style: 'cursor', cursorParam: 'nextPageToken', limitParam: 'maxResults' },
        tags: ['issues', 'search'],
      },
      {
        endpointId: 'getIssue',
        name: 'Get issue',
        description: 'Fetch a single issue by id or key.',
        method: 'GET',
        pathTemplate: '/rest/api/3/issue/{issueIdOrKey}',
        params: [
          {
            name: 'issueIdOrKey',
            location: 'path',
            required: true,
            description: 'The issue id or key (e.g. "PROJ-123").',
            schema: { type: 'string' },
          },
          fieldsParam,
          {
            name: 'expand',
            location: 'query',
            required: false,
            description: 'Comma-separated list of entities to expand in the response.',
            schema: { type: 'string' },
          },
        ],
        tags: ['issues'],
      },
      {
        endpointId: 'createIssue',
        name: 'Create issue',
        description: 'Create a new issue in a project.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/rest/api/3/issue',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The issue fields. Must include project, summary, and issuetype.',
            schema: {
              type: 'object',
              required: ['fields'],
              properties: {
                fields: {
                  type: 'object',
                  required: ['project', 'summary', 'issuetype'],
                  properties: {
                    project: {
                      type: 'object',
                      required: ['key'],
                      properties: { key: { type: 'string' } },
                    },
                    summary: { type: 'string' },
                    issuetype: {
                      type: 'object',
                      required: ['name'],
                      properties: { name: { type: 'string' } },
                    },
                    description: {},
                  },
                  additionalProperties: true,
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['issues'],
      },
      {
        endpointId: 'updateIssue',
        name: 'Update issue',
        description: 'Update fields on an existing issue.',
        method: 'PUT',
        writeRiskTier: 'low',
        pathTemplate: '/rest/api/3/issue/{issueIdOrKey}',
        params: [
          {
            name: 'issueIdOrKey',
            location: 'path',
            required: true,
            description: 'The issue id or key to update.',
            schema: { type: 'string' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The fields to update.',
            schema: {
              type: 'object',
              required: ['fields'],
              properties: {
                fields: { type: 'object', additionalProperties: true },
              },
              additionalProperties: true,
            },
          },
        ],
        tags: ['issues'],
      },
      {
        endpointId: 'getTransitions',
        name: 'Get transitions',
        description: 'List the workflow transitions available for an issue.',
        method: 'GET',
        pathTemplate: '/rest/api/3/issue/{issueIdOrKey}/transitions',
        params: [
          {
            name: 'issueIdOrKey',
            location: 'path',
            required: true,
            description: 'The issue id or key.',
            schema: { type: 'string' },
          },
        ],
        tags: ['issues', 'workflow'],
      },
      {
        endpointId: 'transitionIssue',
        name: 'Transition issue',
        description: 'Move an issue through a workflow transition.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/rest/api/3/issue/{issueIdOrKey}/transitions',
        params: [
          {
            name: 'issueIdOrKey',
            location: 'path',
            required: true,
            description: 'The issue id or key.',
            schema: { type: 'string' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The transition to apply, identified by its id.',
            schema: {
              type: 'object',
              required: ['transition'],
              properties: {
                transition: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
              additionalProperties: true,
            },
          },
        ],
        tags: ['issues', 'workflow'],
      },
      {
        endpointId: 'addComment',
        name: 'Add comment',
        description: 'Add a comment to an issue.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/rest/api/3/issue/{issueIdOrKey}/comment',
        params: [
          {
            name: 'issueIdOrKey',
            location: 'path',
            required: true,
            description: 'The issue id or key.',
            schema: { type: 'string' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description:
              'The comment body — an Atlassian Document Format object or a plain string.',
            schema: {
              type: 'object',
              required: ['body'],
              properties: { body: {} },
              additionalProperties: true,
            },
          },
        ],
        tags: ['issues', 'comments'],
      },
    ],
  },
};
