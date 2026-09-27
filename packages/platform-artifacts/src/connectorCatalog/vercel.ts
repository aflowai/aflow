import type { ConnectorCatalogEntry } from '@aflow/schemas';

const projectIdOrNameParam = {
  name: 'idOrName',
  location: 'path' as const,
  required: true,
  description: 'The project id or name.',
  schema: { type: 'string' },
};

const teamIdParam = {
  name: 'teamId',
  location: 'query' as const,
  required: false,
  description: 'The team id to perform the request on behalf of.',
  schema: { type: 'string' },
};

const limitParam = {
  name: 'limit',
  location: 'query' as const,
  required: false,
  description: 'Maximum number of items to return.',
  schema: { type: 'integer' },
};

const envTargetSchema = {
  type: 'array',
  description: 'Environments the variable applies to.',
  items: { type: 'string', enum: ['production', 'preview', 'development'] },
};

export const VERCEL_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'vercel',
  version: 1,
  name: 'Vercel',
  tagline: 'Manage Vercel projects, deployments, and environment variables.',
  description:
    'Vercel REST API. List and inspect projects, list and inspect deployments, trigger and ' +
    'delete deployments, and read and manage a project’s environment variables. Authenticated ' +
    'with a Vercel access token sent as a bearer token.',
  tags: ['deployment', 'hosting', 'devops', 'ci-cd', 'vercel'],
  vendor: 'Vercel',
  category: 'developer-tools',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create an access token at vercel.com/account/tokens. It is sent as ' +
    'Authorization: Bearer <token>.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Vercel access token',
      setupNote: 'From vercel.com/account/tokens. Sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'vercel',
    name: 'Vercel',
    description: 'Vercel REST API — projects, deployments, and environment variables.',
    baseUrl: 'https://api.vercel.com',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] },
    tags: ['deployment', 'vercel'],
    endpoints: [
      {
        endpointId: 'listProjects',
        name: 'List projects',
        description: 'List the projects on the account or team, paginated and filterable.',
        method: 'GET',
        pathTemplate: '/v10/projects',
        params: [
          teamIdParam,
          limitParam,
          {
            name: 'search',
            location: 'query',
            required: false,
            description: 'Filter projects by name.',
            schema: { type: 'string' },
          },
        ],
        tags: ['projects'],
      },
      {
        endpointId: 'getProject',
        name: 'Get project',
        description: 'Fetch a single project by its id or name.',
        method: 'GET',
        pathTemplate: '/v9/projects/{idOrName}',
        params: [projectIdOrNameParam, teamIdParam],
        tags: ['projects'],
      },
      {
        endpointId: 'listDeployments',
        name: 'List deployments',
        description:
          'List deployments under the account or team, optionally filtered to a single project.',
        method: 'GET',
        pathTemplate: '/v7/deployments',
        params: [
          {
            name: 'projectId',
            location: 'query',
            required: false,
            description: 'Filter deployments to the given project id or name.',
            schema: { type: 'string' },
          },
          teamIdParam,
          limitParam,
        ],
        tags: ['deployments'],
      },
      {
        endpointId: 'getDeployment',
        name: 'Get deployment',
        description:
          'Fetch a single deployment by its id or url, including its build state and metadata.',
        method: 'GET',
        pathTemplate: '/v13/deployments/{idOrUrl}',
        params: [
          {
            name: 'idOrUrl',
            location: 'path',
            required: true,
            description: 'The deployment id or url.',
            schema: { type: 'string' },
          },
          teamIdParam,
        ],
        tags: ['deployments'],
      },
      {
        endpointId: 'createDeployment',
        name: 'Create deployment',
        description:
          'Create a new deployment. The build starts immediately. Set target to "production" to ' +
          'deploy to production; omit it for a preview deployment.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/v13/deployments',
        params: [
          teamIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The deployment request.',
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: {
                  type: 'string',
                  description: 'The project name used in the deployment URL.',
                },
                project: {
                  type: 'string',
                  description: 'The target project id. When set, overrides name.',
                },
                target: {
                  type: 'string',
                  description:
                    'Where to deploy. "production" assigns production aliases; "staging" a ' +
                    'staging alias. Omit for a preview deployment.',
                  enum: ['production', 'staging'],
                },
                deploymentId: {
                  type: 'string',
                  description:
                    'Id of an existing deployment to redeploy. Its settings are inherited unless ' +
                    'overridden here.',
                },
                gitSource: {
                  type: 'object',
                  description: 'The git source to deploy. Cannot be combined with files.',
                  additionalProperties: true,
                },
                files: {
                  type: 'array',
                  description:
                    'Files to deploy for non-git deployments. Cannot be combined with gitSource.',
                  items: { type: 'object', additionalProperties: true },
                },
                meta: {
                  type: 'object',
                  description: 'Arbitrary string key-value metadata attached to the deployment.',
                  additionalProperties: { type: 'string' },
                },
                projectSettings: {
                  type: 'object',
                  description:
                    'Project settings applied to the deployment. Required for a project’s first ' +
                    'deployment.',
                  additionalProperties: true,
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['deployments'],
      },
      {
        endpointId: 'deleteDeployment',
        name: 'Delete deployment',
        description: 'Delete a deployment by its id.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/v13/deployments/{id}',
        params: [
          {
            name: 'id',
            location: 'path',
            required: true,
            description: 'The deployment id.',
            schema: { type: 'string' },
          },
          teamIdParam,
        ],
        tags: ['deployments'],
      },
      {
        endpointId: 'listProjectEnv',
        name: 'List project environment variables',
        description:
          'List a project’s environment variables with their targets and metadata (values are ' +
          'redacted for encrypted/sensitive types).',
        method: 'GET',
        pathTemplate: '/v10/projects/{idOrName}/env',
        params: [projectIdOrNameParam, teamIdParam],
        tags: ['env'],
      },
      {
        endpointId: 'createProjectEnv',
        name: 'Create project environment variable',
        description:
          'Create an environment variable on a project. Affects the running app on the next ' +
          'deployment that reads it.',
        method: 'POST',
        writeRiskTier: 'medium',
        pathTemplate: '/v10/projects/{idOrName}/env',
        params: [
          projectIdOrNameParam,
          teamIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The environment variable to create.',
            schema: {
              type: 'object',
              required: ['key', 'value', 'type', 'target'],
              properties: {
                key: { type: 'string', description: 'The environment variable name.' },
                value: { type: 'string', description: 'The environment variable value.' },
                type: {
                  type: 'string',
                  description: 'The variable type.',
                  enum: ['system', 'encrypted', 'plain', 'sensitive'],
                },
                target: envTargetSchema,
                gitBranch: {
                  type: 'string',
                  description: 'Git branch the variable applies to (requires target "preview").',
                },
                comment: {
                  type: 'string',
                  description: 'A comment describing what this variable is for.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['env'],
      },
      {
        endpointId: 'deleteProjectEnv',
        name: 'Delete project environment variable',
        description:
          'Remove an environment variable from a project by its id. Resolve the id with ' +
          'listProjectEnv.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/v9/projects/{idOrName}/env/{id}',
        params: [
          projectIdOrNameParam,
          {
            name: 'id',
            location: 'path',
            required: true,
            description: 'The environment variable id (from listProjectEnv).',
            schema: { type: 'string' },
          },
          teamIdParam,
        ],
        tags: ['env'],
      },
    ],
  },
};
