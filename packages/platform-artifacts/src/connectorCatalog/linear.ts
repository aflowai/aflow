import type { ApiEndpoint, ConnectorCatalogEntry, WriteRiskTier } from '@aflow/schemas';

// The pinned GraphQL documents below ARE the vetted surface of this connector
// — an agent can only send these exact strings. Body validation happens at
// write time only today; call-time enforcement is the recorded gap in
// Plan 248 §4.1.
const ISSUE_FIELDS =
  'id identifier title priority url createdAt updatedAt ' +
  'state { id name type } assignee { id name } team { id key name }';

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const LIST_ISSUES_QUERY =
  'query Issues($first: Int, $after: String, $filter: IssueFilter) { ' +
  `issues(first: $first, after: $after, filter: $filter) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`;

const GET_ISSUE_QUERY =
  `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description ` +
  `comments { nodes { id body createdAt user { name } } } } }`;

const CREATE_ISSUE_MUTATION =
  'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { ' +
  'success issue { id identifier title url } } }';

const UPDATE_ISSUE_MUTATION =
  'mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { ' +
  'issueUpdate(id: $id, input: $input) { success issue { id identifier title url } } }';

const ADD_COMMENT_MUTATION =
  'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { ' +
  'success comment { id url } } }';

const LIST_TEAMS_QUERY =
  'query Teams($first: Int, $after: String) { teams(first: $first, after: $after) { ' +
  `nodes { id key name } ${PAGE_INFO} } }`;

const LIST_PROJECTS_QUERY =
  'query Projects($first: Int, $after: String) { projects(first: $first, after: $after) { ' +
  `nodes { id name state progress targetDate url } ${PAGE_INFO} } }`;

const LIST_USERS_QUERY =
  'query Users($first: Int, $after: String) { users(first: $first, after: $after) { ' +
  `nodes { id name displayName email active } ${PAGE_INFO} } }`;

function pinnedQuery(document: string): Record<string, unknown> {
  return {
    type: 'string',
    const: document,
    description: 'Pinned GraphQL document — send exactly this string.',
  };
}

const firstVariable = {
  type: 'integer',
  description: 'Page size (max 250).',
};

const afterVariable = {
  type: 'string',
  description: 'The "endCursor" from the previous page. Omit for the first page.',
};

function graphqlEndpoint(opts: {
  endpointId: string;
  name: string;
  description: string;
  document: string;
  variablesSchema: Record<string, unknown>;
  variablesRequired: boolean;
  writeRiskTier: WriteRiskTier;
  tags: string[];
}): ApiEndpoint {
  return {
    endpointId: opts.endpointId,
    name: opts.name,
    description: opts.description,
    method: 'POST',
    writeRiskTier: opts.writeRiskTier,
    pathTemplate: '/graphql',
    params: [
      {
        name: 'body',
        location: 'body',
        required: true,
        description: 'The GraphQL request: the pinned query plus its variables.',
        schema: {
          type: 'object',
          required: opts.variablesRequired ? ['query', 'variables'] : ['query'],
          properties: {
            query: pinnedQuery(opts.document),
            variables: opts.variablesSchema,
          },
          additionalProperties: false,
        },
      },
    ],
    tags: opts.tags,
  };
}

export const LINEAR_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'linear',
  version: 3,
  name: 'Linear',
  tagline: 'List, create, update, and comment on Linear issues, teams, and projects.',
  description:
    'Linear GraphQL API, exposed as a fixed set of typed operations: list and filter issues, ' +
    'read one issue with its comments, create and update issues, add comments, and list ' +
    'teams, projects, and users (the id sources for issue fields). Each operation POSTs a ' +
    'pinned GraphQL document with typed variables. Authenticated with a personal API key ' +
    'sent raw in the Authorization header.',
  tags: ['issue-tracking', 'project-management', 'graphql', 'linear'],
  vendor: 'Linear',
  category: 'project-management',
  honestyLabel: 'curated',
  authKind: 'api_key',
  apiKeyHeaderName: 'Authorization',
  setupNote:
    'Create a personal API key in Linear (Settings → Security & access → Personal API keys). ' +
    'It is sent as the raw value of the Authorization header (no Bearer prefix).',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Linear API key',
      setupNote: 'Personal API key (starts with "lin_api_"). Sent raw in the Authorization header.',
    },
  ],
  definition: {
    apiId: 'linear',
    name: 'Linear',
    description:
      'Linear GraphQL API — issues, comments, teams, projects, users, as pinned typed operations.',
    baseUrl: 'https://api.linear.app',
    version: '1',
    callMode: 'endpoint',
    suggestedEgressPolicy: { allowedMethods: ['POST'] },
    tags: ['issue-tracking', 'linear'],
    endpoints: [
      graphqlEndpoint({
        endpointId: 'listIssues',
        name: 'List issues',
        description:
          'List issues, newest-updated first, optionally filtered by team, state, assignee, ' +
          'or any other IssueFilter field. Cursor-paginated via variables.after.',
        document: LIST_ISSUES_QUERY,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned query.',
          properties: {
            first: firstVariable,
            after: afterVariable,
            filter: {
              type: 'object',
              description:
                'Linear IssueFilter, e.g. { "team": { "key": { "eq": "ENG" } }, ' +
                '"state": { "type": { "eq": "started" } }, "assignee": { "isMe": { "eq": true } } }.',
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        variablesRequired: false,
        writeRiskTier: 'read',
        tags: ['issues'],
      }),
      graphqlEndpoint({
        endpointId: 'getIssue',
        name: 'Get issue',
        description:
          'Fetch one issue by id or identifier (e.g. "ENG-123"), including its description and comments.',
        document: GET_ISSUE_QUERY,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned query.',
          required: ['id'],
          properties: {
            id: {
              type: 'string',
              description: 'The issue UUID or its human identifier (e.g. "ENG-123").',
            },
          },
          additionalProperties: false,
        },
        variablesRequired: true,
        writeRiskTier: 'read',
        tags: ['issues'],
      }),
      graphqlEndpoint({
        endpointId: 'createIssue',
        name: 'Create issue',
        description:
          'Create an issue in a team. Resolve the teamId with listTeams; stateId, assigneeId, ' +
          'and projectId come from listIssues/listUsers/listProjects.',
        document: CREATE_ISSUE_MUTATION,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned mutation.',
          required: ['input'],
          properties: {
            input: {
              type: 'object',
              description: 'The issue to create (Linear IssueCreateInput).',
              required: ['teamId', 'title'],
              properties: {
                teamId: { type: 'string', description: 'UUID of the team the issue belongs to.' },
                title: { type: 'string', description: 'The issue title.' },
                description: { type: 'string', description: 'The issue body (Markdown).' },
                assigneeId: { type: 'string', description: 'UUID of the user to assign.' },
                stateId: { type: 'string', description: 'UUID of the workflow state.' },
                priority: {
                  type: 'integer',
                  description: 'Priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low.',
                },
                projectId: {
                  type: 'string',
                  description: 'UUID of the project to add the issue to.',
                },
                labelIds: {
                  type: 'array',
                  description: 'UUIDs of labels to apply.',
                  items: { type: 'string' },
                },
                dueDate: { type: 'string', description: 'Due date as YYYY-MM-DD.' },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        variablesRequired: true,
        writeRiskTier: 'low',
        tags: ['issues'],
      }),
      graphqlEndpoint({
        endpointId: 'updateIssue',
        name: 'Update issue',
        description:
          'Update fields on an existing issue — title, description, state, assignee, priority, ' +
          'project, labels, due date. Only the fields sent change.',
        document: UPDATE_ISSUE_MUTATION,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned mutation.',
          required: ['id', 'input'],
          properties: {
            id: {
              type: 'string',
              description: 'The issue UUID or its human identifier (e.g. "ENG-123").',
            },
            input: {
              type: 'object',
              description: 'The fields to change (Linear IssueUpdateInput).',
              properties: {
                title: { type: 'string', description: 'New title.' },
                description: { type: 'string', description: 'New body (Markdown).' },
                assigneeId: { type: 'string', description: 'UUID of the user to assign.' },
                stateId: { type: 'string', description: 'UUID of the new workflow state.' },
                priority: {
                  type: 'integer',
                  description: 'Priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low.',
                },
                projectId: {
                  type: 'string',
                  description: 'UUID of the project to move the issue to.',
                },
                labelIds: {
                  type: 'array',
                  description: 'UUIDs of labels; replaces the existing label set.',
                  items: { type: 'string' },
                },
                dueDate: { type: 'string', description: 'Due date as YYYY-MM-DD.' },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        variablesRequired: true,
        writeRiskTier: 'low',
        tags: ['issues'],
      }),
      graphqlEndpoint({
        endpointId: 'addComment',
        name: 'Add comment',
        description: 'Post a comment on an issue.',
        document: ADD_COMMENT_MUTATION,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned mutation.',
          required: ['input'],
          properties: {
            input: {
              type: 'object',
              description: 'The comment to create (Linear CommentCreateInput).',
              required: ['issueId', 'body'],
              properties: {
                issueId: { type: 'string', description: 'UUID of the issue to comment on.' },
                body: { type: 'string', description: 'The comment text (Markdown).' },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        variablesRequired: true,
        writeRiskTier: 'low',
        tags: ['issues', 'comments'],
      }),
      graphqlEndpoint({
        endpointId: 'listTeams',
        name: 'List teams',
        description: 'List the workspace teams — the source of teamId for createIssue.',
        document: LIST_TEAMS_QUERY,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned query.',
          properties: { first: firstVariable, after: afterVariable },
          additionalProperties: false,
        },
        variablesRequired: false,
        writeRiskTier: 'read',
        tags: ['teams'],
      }),
      graphqlEndpoint({
        endpointId: 'listProjects',
        name: 'List projects',
        description: 'List projects with state, progress, and target date.',
        document: LIST_PROJECTS_QUERY,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned query.',
          properties: { first: firstVariable, after: afterVariable },
          additionalProperties: false,
        },
        variablesRequired: false,
        writeRiskTier: 'read',
        tags: ['projects'],
      }),
      graphqlEndpoint({
        endpointId: 'listUsers',
        name: 'List users',
        description: 'List workspace members — the source of assigneeId for issue operations.',
        document: LIST_USERS_QUERY,
        variablesSchema: {
          type: 'object',
          description: 'Variables for the pinned query.',
          properties: { first: firstVariable, after: afterVariable },
          additionalProperties: false,
        },
        variablesRequired: false,
        writeRiskTier: 'read',
        tags: ['users'],
      }),
    ],
  },
};
