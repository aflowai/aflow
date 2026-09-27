import type { ConnectorCatalogEntry } from '@aflow/schemas';

const pageIdParam = {
  name: 'page_id',
  location: 'path' as const,
  required: true,
  description: 'The UUID of the page (with or without dashes).',
  schema: { type: 'string' },
};

const databaseIdParam = {
  name: 'database_id',
  location: 'path' as const,
  required: true,
  description: 'The UUID of the database (with or without dashes).',
  schema: { type: 'string' },
};

const blockIdParam = {
  name: 'block_id',
  location: 'path' as const,
  required: true,
  description: 'The UUID of the block. A page id is also a valid block id (a page is a block).',
  schema: { type: 'string' },
};

const startCursorQueryParam = {
  name: 'start_cursor',
  location: 'query' as const,
  required: false,
  description: 'Cursor from the previous response\'s "next_cursor". Omit for the first page.',
  schema: { type: 'string' },
};

const pageSizeQueryParam = {
  name: 'page_size',
  location: 'query' as const,
  required: false,
  description: 'Number of items to return per page (max 100).',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
};

export const NOTION_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'notion',
  version: 2,
  name: 'Notion',
  tagline: 'Search a workspace, query databases, and create or update pages and content.',
  description:
    'Notion REST API. Search the pages and databases shared with your integration, read a ' +
    'database schema and query its rows with filters and sorts, create pages (as database ' +
    'rows or child pages), update page properties, append content blocks, and read page ' +
    'content. Authenticated with an internal-integration secret sent as a bearer token.',
  tags: ['knowledge-base', 'docs', 'databases', 'productivity', 'notion'],
  vendor: 'Notion',
  category: 'productivity',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create an internal integration at notion.so/profile/integrations and copy its secret ' +
    '(starts with "ntn_" or "secret_"). Then share each target page or database with the ' +
    'integration (page menu → Connections) — content not shared with the integration is ' +
    'invisible to the API.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Internal integration secret',
      setupNote:
        'From notion.so/profile/integrations → your integration → Configuration. Sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'notion',
    name: 'Notion',
    description: 'Notion REST API — search, databases, pages, blocks, users.',
    baseUrl: 'https://api.notion.com',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { 'Notion-Version': '2022-06-28' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PATCH'] },
    tags: ['knowledge-base', 'notion'],
    endpoints: [
      {
        endpointId: 'search',
        name: 'Search',
        description:
          'Search pages and databases shared with the integration by title. An empty query ' +
          'lists everything the integration can see — the way to discover page and database ids.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/v1/search',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description:
              'The search request. Send {} to list everything shared with the integration.',
            schema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description:
                    'Text compared against page and database titles. Omit to match everything.',
                },
                filter: {
                  type: 'object',
                  description: 'Restrict results to only pages or only databases.',
                  required: ['value', 'property'],
                  properties: {
                    value: {
                      type: 'string',
                      enum: ['page', 'database'],
                      description: 'The object type to return.',
                    },
                    property: {
                      type: 'string',
                      enum: ['object'],
                      description: 'Always "object" — the only filterable property.',
                    },
                  },
                  additionalProperties: false,
                },
                sort: {
                  type: 'object',
                  description: 'Sort results by last edited time.',
                  required: ['direction', 'timestamp'],
                  properties: {
                    direction: {
                      type: 'string',
                      enum: ['ascending', 'descending'],
                      description: 'Sort direction.',
                    },
                    timestamp: {
                      type: 'string',
                      enum: ['last_edited_time'],
                      description: 'Always "last_edited_time" — the only sortable timestamp.',
                    },
                  },
                  additionalProperties: false,
                },
                start_cursor: {
                  type: 'string',
                  description: 'Cursor from the previous response\'s "next_cursor".',
                },
                page_size: {
                  type: 'integer',
                  description: 'Results per page (max 100).',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['search'],
      },
      {
        endpointId: 'getPage',
        name: 'Get page',
        description:
          'Fetch a page object — its properties, parent, and metadata. Page content (blocks) ' +
          'comes from getBlockChildren with the page id.',
        method: 'GET',
        pathTemplate: '/v1/pages/{page_id}',
        params: [pageIdParam],
        tags: ['pages'],
      },
      {
        endpointId: 'getDatabase',
        name: 'Get database',
        description:
          'Fetch a database object — its title and property schema (the column names and types ' +
          'queryDatabase filters and createPage properties must match).',
        method: 'GET',
        pathTemplate: '/v1/databases/{database_id}',
        params: [databaseIdParam],
        tags: ['databases'],
      },
      {
        endpointId: 'queryDatabase',
        name: 'Query database',
        description:
          'List the rows (pages) of a database, optionally filtered and sorted by its properties. ' +
          'Read the schema with getDatabase first — filters reference properties by name and type.',
        method: 'POST',
        writeRiskTier: 'read',
        pathTemplate: '/v1/databases/{database_id}/query',
        params: [
          databaseIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The query. Send {} to list all rows unfiltered.',
            schema: {
              type: 'object',
              properties: {
                filter: {
                  type: 'object',
                  description:
                    'A Notion filter object keyed by property name and type, e.g. ' +
                    '{ "property": "Status", "select": { "equals": "Done" } }, or a compound ' +
                    '{ "and": [...] } / { "or": [...] }.',
                  additionalProperties: true,
                },
                sorts: {
                  type: 'array',
                  description: 'Sort criteria applied in order.',
                  items: {
                    type: 'object',
                    required: ['direction'],
                    properties: {
                      property: {
                        type: 'string',
                        description: 'Property name to sort by (set this or timestamp).',
                      },
                      timestamp: {
                        type: 'string',
                        enum: ['created_time', 'last_edited_time'],
                        description: 'Built-in timestamp to sort by (set this or property).',
                      },
                      direction: {
                        type: 'string',
                        enum: ['ascending', 'descending'],
                        description: 'Sort direction.',
                      },
                    },
                    additionalProperties: false,
                  },
                },
                start_cursor: {
                  type: 'string',
                  description: 'Cursor from the previous response\'s "next_cursor".',
                },
                page_size: {
                  type: 'integer',
                  description: 'Rows per page (max 100).',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['databases', 'query'],
      },
      {
        endpointId: 'createPage',
        name: 'Create page',
        description:
          'Create a page — as a row in a database (parent.database_id, properties matching the ' +
          'database schema) or as a child page (parent.page_id, a "title" property).',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/v1/pages',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The page to create.',
            schema: {
              type: 'object',
              required: ['parent', 'properties'],
              properties: {
                parent: {
                  type: 'object',
                  description: 'Where the page lives — set exactly one of database_id or page_id.',
                  properties: {
                    database_id: {
                      type: 'string',
                      description: 'Parent database UUID (the page becomes a row).',
                    },
                    page_id: {
                      type: 'string',
                      description: 'Parent page UUID (the page becomes a child page).',
                    },
                  },
                  additionalProperties: false,
                },
                properties: {
                  type: 'object',
                  description:
                    'Property values keyed by property name, each a typed value object matching ' +
                    'the parent database schema — e.g. { "Name": { "title": [{ "text": ' +
                    '{ "content": "Task" } }] } }. For a child page, only "title" applies.',
                  additionalProperties: true,
                },
                children: {
                  type: 'array',
                  description:
                    'Optional content blocks (paragraphs, headings, lists, …) for the page body.',
                  items: {
                    type: 'object',
                    description:
                      'A Notion block object, e.g. { "type": "paragraph", "paragraph": { "rich_text": [...] } }.',
                    additionalProperties: true,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pages'],
      },
      {
        endpointId: 'updatePage',
        name: 'Update page',
        description:
          "Update a page's property values, or archive/restore it. Only the properties sent " +
          'change; others keep their values.',
        method: 'PATCH',
        writeRiskTier: 'low',
        pathTemplate: '/v1/pages/{page_id}',
        params: [
          pageIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The changes to apply.',
            schema: {
              type: 'object',
              properties: {
                properties: {
                  type: 'object',
                  description:
                    'Property values to change, keyed by property name — same typed value ' +
                    'objects as createPage.',
                  additionalProperties: true,
                },
                archived: {
                  type: 'boolean',
                  description: 'true moves the page to trash; false restores it.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pages'],
      },
      {
        endpointId: 'appendBlockChildren',
        name: 'Append block children',
        description: 'Append content blocks to a page or block — how page body content is written.',
        method: 'PATCH',
        writeRiskTier: 'low',
        pathTemplate: '/v1/blocks/{block_id}/children',
        params: [
          blockIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The blocks to append.',
            schema: {
              type: 'object',
              required: ['children'],
              properties: {
                children: {
                  type: 'array',
                  description: 'Blocks appended in order (max 100 per request).',
                  items: {
                    type: 'object',
                    description:
                      'A Notion block object, e.g. { "type": "paragraph", "paragraph": ' +
                      '{ "rich_text": [{ "text": { "content": "Hello" } }] } }.',
                    additionalProperties: true,
                  },
                },
                after: {
                  type: 'string',
                  description: 'Existing child block id to insert after (defaults to the end).',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['blocks'],
      },
      {
        endpointId: 'getBlockChildren',
        name: 'Get block children',
        description:
          'Read the content blocks of a page or block. Blocks with has_children require a ' +
          'follow-up call with the child block id.',
        method: 'GET',
        pathTemplate: '/v1/blocks/{block_id}/children',
        params: [blockIdParam, startCursorQueryParam, pageSizeQueryParam],
        pagination: { style: 'cursor', cursorParam: 'start_cursor', limitParam: 'page_size' },
        tags: ['blocks'],
      },
      {
        endpointId: 'listUsers',
        name: 'List users',
        description:
          'List the workspace\'s users — resolve people mentioned in "people" properties to ids.',
        method: 'GET',
        pathTemplate: '/v1/users',
        params: [startCursorQueryParam, pageSizeQueryParam],
        pagination: { style: 'cursor', cursorParam: 'start_cursor', limitParam: 'page_size' },
        tags: ['users'],
      },
    ],
  },
};
