import type { ConnectorCatalogEntry } from '@aflow/schemas';

const baseIdParam = {
  name: 'baseId',
  location: 'path' as const,
  required: true,
  description: 'The base id (starts with "app"). Discover it with listBases.',
  schema: { type: 'string' },
};

const tableIdOrNameParam = {
  name: 'tableIdOrName',
  location: 'path' as const,
  required: true,
  description:
    'The table id (starts with "tbl") or its name. Prefer the id — names break when renamed.',
  schema: { type: 'string' },
};

const recordIdParam = {
  name: 'recordId',
  location: 'path' as const,
  required: true,
  description: 'The record id (starts with "rec").',
  schema: { type: 'string' },
};

export const AIRTABLE_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'airtable',
  version: 2,
  name: 'Airtable',
  tagline: 'Read, filter, create, and update records in Airtable bases.',
  description:
    'Airtable Web API. Discover bases and table schemas, list records with formula filters ' +
    'and views, read single records, and create, update, or delete records. Field values ' +
    'are keyed by field name per the table schema — read getBaseSchema first. ' +
    'Authenticated with a personal access token sent as a bearer token.',
  tags: ['databases', 'spreadsheets', 'records', 'no-code', 'airtable'],
  vendor: 'Airtable',
  category: 'databases',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Create a personal access token at airtable.com/create/tokens with scopes ' +
    'data.records:read, data.records:write, and schema.bases:read, granted access to the ' +
    'bases you want to use. It is sent as Authorization: Bearer <token>.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Personal access token',
      setupNote:
        'From airtable.com/create/tokens (starts with "pat"). Needs data.records:read/write + schema.bases:read on the target bases.',
    },
  ],
  definition: {
    apiId: 'airtable',
    name: 'Airtable',
    description: 'Airtable Web API — bases, table schemas, and record CRUD.',
    baseUrl: 'https://api.airtable.com',
    version: '1',
    callMode: 'endpoint',
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] },
    tags: ['databases', 'airtable'],
    endpoints: [
      {
        endpointId: 'listBases',
        name: 'List bases',
        description: 'List the bases the token can access, with their ids — the entry point.',
        method: 'GET',
        pathTemplate: '/v0/meta/bases',
        params: [
          {
            name: 'offset',
            location: 'query',
            required: false,
            description: 'Cursor from the previous response\'s "offset". Omit for the first page.',
            schema: { type: 'string' },
          },
        ],
        pagination: { style: 'cursor', cursorParam: 'offset' },
        tags: ['bases'],
      },
      {
        endpointId: 'getBaseSchema',
        name: 'Get base schema',
        description:
          "List a base's tables with their ids, fields, and field types — the schema record " +
          'fields must match when reading or writing.',
        method: 'GET',
        pathTemplate: '/v0/meta/bases/{baseId}/tables',
        params: [baseIdParam],
        tags: ['bases', 'schema'],
      },
      {
        endpointId: 'listRecords',
        name: 'List records',
        description:
          "List a table's records, optionally restricted to a view and filtered with an " +
          'Airtable formula (e.g. {Status}="Done"). Cursor-paginated via "offset".',
        method: 'GET',
        pathTemplate: '/v0/{baseId}/{tableIdOrName}',
        params: [
          baseIdParam,
          tableIdOrNameParam,
          {
            name: 'filterByFormula',
            location: 'query',
            required: false,
            description:
              'Airtable formula that must evaluate true for a record to be returned, e.g. {Status}="Done".',
            schema: { type: 'string' },
          },
          {
            name: 'view',
            location: 'query',
            required: false,
            description: 'Return only records visible in this view (name or id), in view order.',
            schema: { type: 'string' },
          },
          {
            name: 'maxRecords',
            location: 'query',
            required: false,
            description: 'Total record cap across all pages.',
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'pageSize',
            location: 'query',
            required: false,
            description: 'Records per page (max 100).',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
          },
          {
            name: 'offset',
            location: 'query',
            required: false,
            description: 'Cursor from the previous response\'s "offset". Omit for the first page.',
            schema: { type: 'string' },
          },
        ],
        pagination: { style: 'cursor', cursorParam: 'offset', limitParam: 'pageSize' },
        tags: ['records'],
      },
      {
        endpointId: 'getRecord',
        name: 'Get record',
        description: 'Fetch a single record with all its field values.',
        method: 'GET',
        pathTemplate: '/v0/{baseId}/{tableIdOrName}/{recordId}',
        params: [baseIdParam, tableIdOrNameParam, recordIdParam],
        tags: ['records'],
      },
      {
        endpointId: 'createRecords',
        name: 'Create records',
        description: 'Create up to 10 records in a table in one call.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/v0/{baseId}/{tableIdOrName}',
        params: [
          baseIdParam,
          tableIdOrNameParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The records to create.',
            schema: {
              type: 'object',
              required: ['records'],
              properties: {
                records: {
                  type: 'array',
                  description: 'Records to create (max 10 per call).',
                  items: {
                    type: 'object',
                    required: ['fields'],
                    properties: {
                      fields: {
                        type: 'object',
                        description:
                          'Field values keyed by field name (or field id), matching the table ' +
                          'schema — e.g. { "Name": "Task", "Status": "Todo" }.',
                        additionalProperties: true,
                      },
                    },
                    additionalProperties: false,
                  },
                },
                typecast: {
                  type: 'boolean',
                  description:
                    'Coerce string values into typed cells (e.g. auto-create select options). Default false.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['records'],
      },
      {
        endpointId: 'updateRecords',
        name: 'Update records',
        description:
          'Update up to 10 records in one call. Only the fields sent change; others keep their values.',
        method: 'PATCH',
        writeRiskTier: 'low',
        pathTemplate: '/v0/{baseId}/{tableIdOrName}',
        params: [
          baseIdParam,
          tableIdOrNameParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The record updates to apply.',
            schema: {
              type: 'object',
              required: ['records'],
              properties: {
                records: {
                  type: 'array',
                  description: 'Records to update (max 10 per call).',
                  items: {
                    type: 'object',
                    required: ['id', 'fields'],
                    properties: {
                      id: {
                        type: 'string',
                        description: 'The record id (starts with "rec").',
                      },
                      fields: {
                        type: 'object',
                        description: 'Field values to change, keyed by field name (or field id).',
                        additionalProperties: true,
                      },
                    },
                    additionalProperties: false,
                  },
                },
                typecast: {
                  type: 'boolean',
                  description:
                    'Coerce string values into typed cells (e.g. auto-create select options). Default false.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['records'],
      },
      {
        endpointId: 'deleteRecord',
        name: 'Delete record',
        description: 'Delete a single record.',
        method: 'DELETE',
        writeRiskTier: 'medium',
        pathTemplate: '/v0/{baseId}/{tableIdOrName}/{recordId}',
        params: [baseIdParam, tableIdOrNameParam, recordIdParam],
        tags: ['records'],
      },
    ],
  },
};
