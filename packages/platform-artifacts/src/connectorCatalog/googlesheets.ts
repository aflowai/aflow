import type { ConnectorCatalogEntry } from '@aflow/schemas';

const spreadsheetIdParam = {
  name: 'spreadsheetId',
  location: 'path' as const,
  required: true,
  description: 'The spreadsheet ID — the long token in the sheet URL between /d/ and /edit.',
  schema: { type: 'string' },
};

const rangeParam = {
  name: 'range',
  location: 'path' as const,
  required: true,
  description:
    'The A1-notation range to operate on (e.g. "Sheet1!A1:C10", or "Sheet1" for the whole tab).',
  schema: { type: 'string' },
};

const valueInputOptionParam = {
  name: 'valueInputOption',
  location: 'query' as const,
  required: true,
  description:
    'How the written values are interpreted. USER_ENTERED parses them as if typed in the UI ' +
    '(formulas, dates, numbers). RAW stores each value verbatim as a string.',
  schema: { type: 'string', enum: ['USER_ENTERED', 'RAW'] },
};

const valueRangeBodySchema = {
  type: 'object',
  description: 'A ValueRange — the cells to write.',
  properties: {
    range: {
      type: 'string',
      description: 'The A1-notation range the values cover. Should match the range in the path.',
    },
    majorDimension: {
      type: 'string',
      enum: ['ROWS', 'COLUMNS'],
      description: 'Whether the outer array of "values" is rows (default) or columns.',
    },
    values: {
      type: 'array',
      description:
        'The cell values as a 2-D array — an array of rows, each row an array of cell values.',
      items: {
        type: 'array',
        items: {},
      },
    },
  },
  additionalProperties: false,
};

export const GOOGLE_SHEETS_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'google-sheets',
  version: 1,
  name: 'Google Sheets',
  tagline: 'Read and write spreadsheet values, edit structure, and create new spreadsheets.',
  description:
    'Google Sheets API v4. Read a spreadsheet’s metadata and cell values, write and append ' +
    'values to a range, clear a range, apply structural edits (add sheets, formatting, and other ' +
    'requests) via batchUpdate, and create a new spreadsheet. Authenticated with Google OAuth 2 ' +
    'through the consent flow — no token is pasted. The single requested scope, ' +
    'https://www.googleapis.com/auth/spreadsheets, grants read and write to spreadsheets the ' +
    'connected account can access; it does not request broad Drive access.',
  tags: ['spreadsheets', 'productivity', 'google', 'sheets', 'data'],
  vendor: 'Google',
  category: 'productivity',
  honestyLabel: 'curated',
  authKind: 'oauth2_authorization_code',
  oauthIssuerKey: 'google',
  oauthScopes: ['https://www.googleapis.com/auth/spreadsheets'],
  setupNote:
    'Register an OAuth app in the Google Cloud Console (APIs & Services → Credentials → Create ' +
    'Credentials → OAuth client ID → Web application), enable the Google Sheets API for the ' +
    'project, and add this platform’s callback as an authorized redirect URI. Copy the Client ID ' +
    'and Client Secret into this space’s Settings → OAuth Apps, then click Connect and approve ' +
    'access in Google — nothing to paste here. The Sheets scope is a sensitive scope, so the ' +
    'Google app must be verified (or kept in testing mode with the connecting account added as a ' +
    'test user).',
  definition: {
    apiId: 'google-sheets',
    name: 'Google Sheets',
    description: 'Google Sheets API v4 — read, write, structure edits, and spreadsheet creation.',
    baseUrl: 'https://sheets.googleapis.com/v4',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PUT'] },
    tags: ['spreadsheets', 'google'],
    endpoints: [
      {
        endpointId: 'getSpreadsheet',
        name: 'Get spreadsheet',
        description:
          'Fetch a spreadsheet’s metadata and structure — its properties, sheets (tabs), and ' +
          'named ranges. Does not return cell values unless includeGridData is set.',
        method: 'GET',
        pathTemplate: '/spreadsheets/{spreadsheetId}',
        params: [
          spreadsheetIdParam,
          {
            name: 'includeGridData',
            location: 'query',
            required: false,
            description:
              'Set true to include cell grid data in the response. Large — usually leave it off ' +
              'and read values via getValues instead.',
            schema: { type: 'boolean' },
          },
        ],
        tags: ['spreadsheets'],
      },
      {
        endpointId: 'getValues',
        name: 'Get values',
        description: 'Read the cell values from a range, in A1 notation, as a 2-D array.',
        method: 'GET',
        pathTemplate: '/spreadsheets/{spreadsheetId}/values/{range}',
        params: [
          spreadsheetIdParam,
          rangeParam,
          {
            name: 'majorDimension',
            location: 'query',
            required: false,
            description: 'Whether the returned "values" are grouped by ROWS (default) or COLUMNS.',
            schema: { type: 'string', enum: ['ROWS', 'COLUMNS'] },
          },
          {
            name: 'valueRenderOption',
            location: 'query',
            required: false,
            description:
              'How values are rendered: FORMATTED_VALUE (default), UNFORMATTED_VALUE, or FORMULA.',
            schema: {
              type: 'string',
              enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
            },
          },
        ],
        tags: ['values'],
      },
      {
        endpointId: 'updateValues',
        name: 'Update values',
        description:
          'Overwrite the cell values in a range. The range in the path and the range in the ' +
          'ValueRange body should match. Only the cells covered by the values are changed.',
        method: 'PUT',
        writeRiskTier: 'low',
        pathTemplate: '/spreadsheets/{spreadsheetId}/values/{range}',
        bodyEncoding: 'json',
        params: [
          spreadsheetIdParam,
          rangeParam,
          valueInputOptionParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The values to write into the range.',
            schema: valueRangeBodySchema,
          },
        ],
        tags: ['values'],
      },
      {
        endpointId: 'appendValues',
        name: 'Append values',
        description:
          'Append rows after the last row of a table detected at or around the given range. ' +
          'The range locates the table; new data is written below it, growing the sheet as needed.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/spreadsheets/{spreadsheetId}/values/{range}:append',
        bodyEncoding: 'json',
        params: [
          spreadsheetIdParam,
          rangeParam,
          valueInputOptionParam,
          {
            name: 'insertDataOption',
            location: 'query',
            required: false,
            description:
              'How new data is inserted: OVERWRITE writes over existing cells below the table; ' +
              'INSERT_ROWS inserts new rows for the data.',
            schema: { type: 'string', enum: ['OVERWRITE', 'INSERT_ROWS'] },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The rows to append.',
            schema: valueRangeBodySchema,
          },
        ],
        tags: ['values'],
      },
      {
        endpointId: 'clearValues',
        name: 'Clear values',
        description:
          'Clear the values from a range, leaving formatting and other cell properties intact. ' +
          'Takes an empty JSON body.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/spreadsheets/{spreadsheetId}/values/{range}:clear',
        bodyEncoding: 'json',
        params: [
          spreadsheetIdParam,
          rangeParam,
          {
            name: 'body',
            location: 'body',
            required: false,
            description: 'Empty request body — the range to clear is carried in the path.',
            schema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        tags: ['values'],
      },
      {
        endpointId: 'batchUpdate',
        name: 'Batch update',
        description:
          'Apply one or more structural edits to the spreadsheet in a single atomic call — add or ' +
          'delete sheets, format cells, set values, insert rows, and more. Each edit is a Request ' +
          'object in the "requests" array (see the Sheets API batchUpdate reference).',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/spreadsheets/{spreadsheetId}:batchUpdate',
        bodyEncoding: 'json',
        params: [
          spreadsheetIdParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The batch of update requests.',
            schema: {
              type: 'object',
              required: ['requests'],
              properties: {
                requests: {
                  type: 'array',
                  description:
                    'The ordered edits to apply. Each item is a Sheets API Request object ' +
                    '(e.g. { addSheet }, { updateCells }, { repeatCell }, { deleteDimension }).',
                  items: { type: 'object', additionalProperties: true },
                },
                includeSpreadsheetInResponse: {
                  type: 'boolean',
                  description: 'Set true to return the updated spreadsheet in the response.',
                },
                responseIncludeGridData: {
                  type: 'boolean',
                  description:
                    'When includeSpreadsheetInResponse is true, also include cell grid data.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['structure'],
      },
      {
        endpointId: 'createSpreadsheet',
        name: 'Create spreadsheet',
        description:
          'Create a new spreadsheet, optionally seeding its title and initial sheets (tabs). ' +
          'Returns the new spreadsheet, including its spreadsheetId.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/spreadsheets',
        bodyEncoding: 'json',
        params: [
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The spreadsheet to create.',
            schema: {
              type: 'object',
              properties: {
                properties: {
                  type: 'object',
                  description:
                    'Top-level spreadsheet properties. Set "title" here to name the new sheet.',
                  properties: {
                    title: {
                      type: 'string',
                      description: 'The title of the new spreadsheet.',
                    },
                  },
                  additionalProperties: true,
                },
                sheets: {
                  type: 'array',
                  description:
                    'Initial sheets (tabs) to create. Each item is a Sheet object; commonly just ' +
                    '{ properties: { title } }.',
                  items: { type: 'object', additionalProperties: true },
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['spreadsheets'],
      },
    ],
  },
};
