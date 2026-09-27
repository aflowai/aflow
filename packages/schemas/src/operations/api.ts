/**
 * API step operation schemas (v2).
 *
 * Implements the Definition vs Binding boundary:
 * - Agent supplies: apiId, endpointId, params (declarative, no secrets)
 * - Executor resolves: binding, credentials, baseUrl, egress policy (at runtime)
 *
 * Two call modes:
 * - Endpoint mode (apiId + endpointId): the standard path for static endpoints.
 * - Direct-URL mode (apiId + bindingId + url): the sanctioned way to call a
 *   signed/dynamic cross-host URL (e.g. a GCS resumable-upload URL an API hands
 *   back at runtime). Production-safe — the binding's egressPolicy.allowedHosts is
 *   the security boundary. A bare url with no apiId/bindingId stays dev-only
 *   (allowUnsafeDirectUrl).
 */
import { z } from 'zod';
import { MemoryDocTypeSchema } from './memory.js';

// ============================================================================
// Shared Types
// ============================================================================

export const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const HttpHeadersSchema = z.record(z.string());
export type HttpHeaders = z.infer<typeof HttpHeadersSchema>;

// ============================================================================
// api.http.call — v2 Input (what agents supply)
// ============================================================================

export const ApiCallInputSchema = z
  .object({
    apiId: z
      .string()
      .max(128)
      .describe(
        'API definition ID (e.g. "github", "stripe"). Pair with endpointId (endpoint mode) ' +
          'or bindingId + url (direct-URL mode, for a signed cross-host URL).',
      )
      .optional(),
    endpointId: z
      .string()
      .max(128)
      .describe(
        'Endpoint ID within the API definition (e.g. "download_file", "list_repos"). ' +
          'Required with apiId in endpoint mode; omit in direct-URL mode (apiId + bindingId + url). ' +
          'Use api.definition.list to discover available endpoints.',
      )
      .optional(),
    params: z
      .record(z.unknown())
      .describe('Endpoint parameters (path, query, header, body — keyed by param name)')
      .optional(),

    bindingId: z
      .string()
      .max(128)
      .describe(
        'Binding ID. Required with apiId + url (direct-URL mode); optional hint with apiId + endpointId.',
      )
      .optional(),

    url: z
      .string()
      .url()
      .max(2048)
      .describe(
        'Direct URL. With apiId + bindingId this is direct-URL mode — the sanctioned ' +
          'production path for signed/dynamic cross-host URLs (e.g. a GCS resumable-upload ' +
          "URL), gated by the binding's egressPolicy.allowedHosts. A bare url (no apiId/bindingId) " +
          'is dev-only and requires allowUnsafeDirectUrl.',
      )
      .optional(),
    method: HttpMethodSchema.describe('HTTP method (only used with direct URL mode)').default(
      'GET',
    ),
    headers: HttpHeadersSchema.describe(
      'Additional headers (merged, never overrides auth)',
    ).optional(),
    body: z.unknown().describe('Request body (only used with direct URL mode)').optional(),
    bodySource: z
      .object({
        fromPath: z
          .string()
          .max(1024)
          .describe(
            'Memory path whose content becomes the request body, e.g. ' +
              '"/workspace/data/project/submission.csv" (the /workspace/ prefix is ' +
              "stripped to the underlying Memory path). Binary-safe. The Memory doc's " +
              'mimeType sets Content-Type unless a Content-Type header is provided.',
          ),
        emitContentRange: z
          .boolean()
          .optional()
          .describe(
            'Emit "Content-Range: bytes 0-(N-1)/N" derived from the resolved body byte length ' +
              '(single-request form of ranged/resumable uploads). Do not also supply a manual ' +
              'Content-Range header — the executor owns it.',
          ),
      })
      .describe('By-reference request body from a Memory path.')
      .optional(),
    queryParams: z.record(z.string()).describe('Query string parameters').optional(),

    response: z
      .object({
        format: z.enum(['json', 'text', 'binary']).default('json'),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(104_857_600)
          .optional()
          .describe(
            'Max response size in bytes. Omit to use the mode default: 10 MB for an inline ' +
              'response, or the 100 MB ceiling for a `saveTo` download (which persists to a ' +
              'Memory path instead of inlining). An explicit value always applies.',
          ),
        transformPresetId: z.string().max(128).optional(),
        validateResponse: z.boolean().default(false),
        saveTo: z
          .object({
            path: z
              .string()
              .min(1)
              .max(1024)
              .refine((p) => !p.startsWith('/run/'), {
                message:
                  'Cannot save to virtual /run/ paths — use a persistent path like /workspace/data/...',
              })
              .describe(
                'Memory path to save the response body to, e.g. ' +
                  '"/workspace/data/project/train.csv" (the /workspace/ prefix is stripped ' +
                  'to the underlying Memory path).',
              ),
            docType: MemoryDocTypeSchema.optional().describe(
              'Memory docType override. Defaults from the response Content-Type ' +
                '(binary content is stored on the binary lane automatically).',
            ),
            mimeType: z
              .string()
              .max(128)
              .optional()
              .describe('MIME type override. Defaults from the response Content-Type header.'),
            indexing: z
              .enum(['auto', 'disabled', 'force'])
              .optional()
              .describe(
                'Whether to chunk/embed the saved body for semantic search. Omit for the ' +
                  'default ("auto"); set "disabled" for raw data (a large CSV/dataset is data, ' +
                  'not knowledge to embed).',
              ),
          })
          .optional()
          .describe(
            'Persist the response body to a Memory path. Output carries ' +
              'savedTo + sizeBytes; the body is NOT returned inline. Read it back via ' +
              'memory.store.get or feed it onward via bodySource.fromPath / compute inputPaths.',
          ),
      })
      .default({}),

    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .describe('Request timeout in milliseconds')
      .default(30_000),
  })
  .refine((data) => data.apiId !== undefined || data.url !== undefined, {
    message: "Either 'apiId' (with 'endpointId') or 'url' (direct mode) is required",
  })
  .refine((data) => !(data.body !== undefined && data.bodySource !== undefined), {
    message: 'Provide either body or bodySource.fromPath, not both',
    path: ['bodySource'],
  })
  .refine(
    (data) =>
      !(
        data.bodySource?.emitContentRange === true &&
        data.headers !== undefined &&
        Object.keys(data.headers).some((k) => k.toLowerCase() === 'content-range')
      ),
    {
      message:
        'Do not supply a manual Content-Range header with bodySource.emitContentRange — ' +
        'the executor derives it from the resolved body byte length (one source of truth).',
      path: ['headers'],
    },
  )
  // 'endpointId' required when 'apiId' is provided AND no literal 'url'.
  .refine(
    (data) => data.apiId === undefined || data.endpointId !== undefined || data.url !== undefined,
    {
      message:
        "'endpointId' is required when 'apiId' is provided without 'url' (direct-URL mode requires 'bindingId' instead)",
      path: ['endpointId'],
    },
  )
  .refine(
    (data) => data.url === undefined || data.apiId === undefined || data.bindingId !== undefined,
    {
      message:
        "'bindingId' is required when using 'apiId' + 'url' (direct-URL mode) — the binding's egressPolicy.allowedHosts is the security boundary",
      path: ['bindingId'],
    },
  );

export type ApiCallInput = z.infer<typeof ApiCallInputSchema>;

// ============================================================================
// api.http.call — v2 Output (stable envelope)
// ============================================================================

export const ApiCallOutputSchema = z.object({
  statusCode: z.number().int().min(100).max(599),
  headers: HttpHeadersSchema.describe('Response headers (sensitive headers redacted)'),
  data: z
    .unknown()
    .describe(
      'Response body. JSON/text responses inline this directly. Binary responses leave this undefined — bytes are accessible via `dataRef`. ' +
        'To forward to another step (works for all formats): {"$ref": "output.<toolCallId>/data"} — the platform auto-dereferences `dataRef` for binary/large responses.',
    ),
  dataRef: z
    .string()
    .optional()
    .describe(
      'PayloadRef for non-inline bodies (binary responses always; large JSON/text when over the inline budget). ' +
        'Prefer `{"$ref": "output.<toolCallId>/data"}` over reading this directly — the resolver auto-derefs it transparently.',
    ),
  rawBodyRef: z
    .string()
    .optional()
    .describe(
      'PayloadRef for the untransformed response text when a response transform normalized ' +
        '`data`. Internal debugging handle only — stripped from agent-visible summaries.',
    ),
  durationMs: z.number().int().nonnegative(),
  savedTo: z
    .string()
    .optional()
    .describe(
      'Memory path the response body was saved to (response.saveTo). The body is NOT ' +
        'returned inline — read it via memory.store.get or reference it by path.',
    ),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Byte size of the saved response body (present with savedTo).'),
  finalUrl: z.string().optional(),
  wasRetried: z.boolean().optional(),
  backend: z
    .enum(['http', 'simulated'])
    .default('http')
    .describe(
      'Which path produced this response. `simulated` means a Simulation answered it and no ' +
        'network request was made.',
    ),
  apiId: z.string().optional(),
  endpointId: z.string().optional(),
  truncated: z
    .boolean()
    .default(false)
    .describe('True if the response body was truncated due to size limits'),
  originalSizeBytes: z
    .number()
    .int()
    .optional()
    .describe('Original response size before truncation (only present when truncated)'),
  parsedMeta: z
    .object({
      paginationCursor: z.string().optional(),
      contentType: z.string().optional(),
      sourceContentType: z
        .string()
        .optional()
        .describe(
          'The upstream media type when a response transform normalized the body to JSON ' +
            '(contentType then reports application/json).',
        ),
    })
    .optional(),
});
export type ApiCallOutput = z.infer<typeof ApiCallOutputSchema>;

// ============================================================================
// api.http.download — destination-mandated streaming download
// ============================================================================

/**
 * A narrowed sibling of api.http.call whose destination is REQUIRED, so an
 * inline download is not expressible. The whole body streams straight to a
 * memory path (buffered, budget-checked) and is never returned in the turn.
 */
export const ApiHttpDownloadInputSchema = z
  .object({
    apiId: z
      .string()
      .max(128)
      .describe(
        'API definition ID (e.g. "kaggle"). Pair with endpointId (endpoint mode) or ' +
          'bindingId + url (direct-URL mode, for a signed cross-host download URL).',
      )
      .optional(),
    endpointId: z
      .string()
      .max(128)
      .describe(
        'Endpoint ID within the API definition. Required with apiId in endpoint mode; ' +
          'omit in direct-URL mode (apiId + bindingId + url).',
      )
      .optional(),
    params: z
      .record(z.unknown())
      .describe('Endpoint parameters (path, query, header — keyed by param name)')
      .optional(),
    bindingId: z
      .string()
      .max(128)
      .describe(
        'Binding ID. Required with apiId + url (direct-URL mode); optional hint with apiId + endpointId.',
      )
      .optional(),
    url: z
      .string()
      .url()
      .max(2048)
      .describe(
        'Direct URL. With apiId + bindingId this is direct-URL mode — the sanctioned path for ' +
          "a signed/dynamic cross-host download URL, gated by the binding's egressPolicy.allowedHosts.",
      )
      .optional(),
    queryParams: z.record(z.string()).describe('Query string parameters').optional(),
    headers: HttpHeadersSchema.describe(
      'Additional headers (merged, never overrides auth)',
    ).optional(),

    toMemoryPath: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !p.startsWith('/run/'), {
        message:
          'Cannot save to virtual /run/ paths — use a persistent path like /workspace/data/...',
      })
      .describe(
        'REQUIRED. Memory path the response body streams to, e.g. ' +
          '"/workspace/data/project/train.csv" (the /workspace/ prefix is stripped to the ' +
          'underlying Memory path). The body is never returned inline — read it back with ' +
          'memory.store.get, or hydrate it into a sandbox via inputPaths.',
      ),
    docType: MemoryDocTypeSchema.optional().describe(
      'Memory docType override. Defaults from the response Content-Type ' +
        '(binary content is stored on the binary lane automatically).',
    ),
    mimeType: z
      .string()
      .max(128)
      .optional()
      .describe('MIME type override. Defaults from the response Content-Type header.'),
    indexing: z
      .enum(['auto', 'disabled', 'force'])
      .default('disabled')
      .describe(
        'Whether to chunk/embed the saved body for semantic search. Defaults to "disabled" — a ' +
          'downloaded dataset/CSV/artifact is raw data, not knowledge to embed. Set "auto" only ' +
          'for a document you actually want semantically searchable.',
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .describe(
        'Request timeout in milliseconds. Defaults high because downloads are large; the ' +
          'binding egress policy timeout also applies (the smaller of the two wins).',
      )
      .default(120_000),
  })
  .refine((data) => data.apiId !== undefined || data.url !== undefined, {
    message: "Either 'apiId' (with 'endpointId') or 'url' (direct mode) is required",
  })
  .refine(
    (data) => data.apiId === undefined || data.endpointId !== undefined || data.url !== undefined,
    {
      message:
        "'endpointId' is required when 'apiId' is provided without 'url' (direct-URL mode requires 'bindingId' instead)",
      path: ['endpointId'],
    },
  )
  .refine(
    (data) => data.url === undefined || data.apiId === undefined || data.bindingId !== undefined,
    {
      message:
        "'bindingId' is required when using 'apiId' + 'url' (direct-URL mode) — the binding's egressPolicy.allowedHosts is the security boundary",
      path: ['bindingId'],
    },
  );

export type ApiHttpDownloadInput = z.infer<typeof ApiHttpDownloadInputSchema>;

export const ApiHttpDownloadOutputSchema = z.object({
  path: z
    .string()
    .describe(
      'Memory path the response body was streamed to. Read it back with memory.store.get, or ' +
        'hydrate it into a sandbox via inputPaths — it was never returned inline.',
    ),
  sizeBytes: z.number().int().nonnegative().describe('Byte size of the saved body.'),
  contentType: z
    .string()
    .optional()
    .describe('Response Content-Type, when the server provided one.'),
});
export type ApiHttpDownloadOutput = z.infer<typeof ApiHttpDownloadOutputSchema>;

// ============================================================================

import type { OperationRegistration } from '../catalog/operationCatalog.js';

import {
  PlatformApiUpsertDefinitionInputSchema,
  PlatformApiUpsertDefinitionOutputSchema,
  PlatformApiPatchDefinitionInputSchema,
  PlatformApiPatchDefinitionOutputSchema,
  PlatformApiDeleteDefinitionInputSchema,
  PlatformApiDeleteDefinitionOutputSchema,
  PlatformApiGetDefinitionInputSchema,
  PlatformApiGetDefinitionOutputSchema,
  PlatformListApiDefinitionsInputSchema,
  PlatformListApiDefinitionsOutputSchema,
  PlatformApiImportOpenApiInputSchema,
  PlatformApiImportOpenApiOutputSchema,
  PlatformApiUpsertBindingInputSchema,
  PlatformApiUpsertBindingOutputSchema,
  PlatformApiDeleteBindingInputSchema,
  PlatformApiDeleteBindingOutputSchema,
  PlatformApiGetBindingInputSchema,
  PlatformApiGetBindingOutputSchema,
  PlatformApiListBindingsInputSchema,
  PlatformApiListBindingsOutputSchema,
  PlatformApiBindingTestInputSchema,
  PlatformApiBindingTestOutputSchema,
} from './platform.js';

export const ApiOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'api',
    group: 'http',
    verb: 'call',
    name: 'Call API',
    actionLabel: 'Calling API…',
    semanticDescription:
      'Call a registered API endpoint. Use apiId + endpointId + params. ' +
      'Run api.definition.list first to discover available APIs and their endpoints. ' +
      'The executor resolves credentials and enforces egress policies at runtime. ' +
      'For a signed/dynamic cross-host URL an API returns at runtime (e.g. a GCS upload URL), ' +
      'use direct-URL mode: apiId + bindingId + url, gated by the binding egress allowlist.',
    tags: ['api', 'http', 'integration'],
    idempotency: 'unknown',
    mutates: true,
    usage: {
      oneLine:
        'Call an external API via a configured integration. Endpoint mode: apiId + endpointId ' +
        '(use api.definition.list). Direct-URL mode: apiId + bindingId + url for a signed cross-host URL.',
      whenToUse: [
        'Calling HTTP APIs through a registered integration',
        'Fetching data from third-party services (GitHub, Stripe, etc.)',
        'PUT/GET to a signed cross-host URL an API hands back at runtime (e.g. a GCS upload/download URL) — direct-URL mode: apiId + bindingId + url',
      ],
      whenNotToUse: [
        'Calling internal platform operations — use catalog.* or space.manage.* instead',
        'Searching the web — use search.web.search instead',
      ],
      pitfalls: [
        'Two modes: endpoint mode = apiId + endpointId (do not hand-build URLs for static endpoints); direct-URL mode = apiId + bindingId + url for a signed/dynamic cross-host URL (e.g. a GCS upload URL), gated by the binding egress allowlist.',
        'Direct-URL mode: the url host MUST be in that binding egress allowlist; do not add the signed URL as a static endpoint on the primary integration.',
        'Agents never see or handle credentials — the executor resolves them at runtime. Direct-URL mode sends NO binding auth (use a credential-less binding for third-party blob hosts).',
      ],
      minimalExampleInput: {
        apiId: 'github',
        endpointId: 'list_repos',
        params: { owner: 'octocat' },
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: ApiCallInputSchema,
    outputZod: ApiCallOutputSchema,
  },

  {
    stepType: 'api',
    group: 'http',
    verb: 'download',
    name: 'Download to Memory',
    actionLabel: 'Downloading…',
    semanticDescription:
      'Stream an HTTP response body straight to a memory path — it is never returned inline. ' +
      'For a body too large or too raw to read into context (a dataset, a CSV, a model artifact), ' +
      'this fetches it through a bound API and writes it to the memory path you name, so a later ' +
      'step can hydrate it into a sandbox (inputPaths) or read it back (memory.store.get). ' +
      'Endpoint mode: apiId + endpointId. Direct-URL mode: apiId + bindingId + url for a signed ' +
      'cross-host download URL, gated by the binding egress allowlist.',
    tags: ['api', 'http', 'download', 'dataset', 'file'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Stream an HTTP body to a memory path (never inline) — for a file/dataset/CSV too large ' +
        'or too raw to read into your turn.',
      whenToUse: [
        'You need a file (dataset, CSV, model artifact, any large body) written to a memory path rather than read into your turn',
        'Fetching competition/reference data through a bound API to hydrate a sandbox later',
      ],
      whenNotToUse: [
        'You need the response value itself in this turn (a small JSON API result) — use api.http.call',
        'Writing content you already have in context — use memory.store.put',
      ],
      pitfalls: [
        'toMemoryPath is required — the body streams there and is NOT returned to you inline. Read it back with memory.store.get if you need to inspect it.',
        'Set indexing:"disabled" (the default) for raw data so it is not chunked/embedded; only set "auto" for a document you want semantically searchable.',
        'The binding egress allowlist still applies — a disallowed host is blocked exactly as for api.http.call.',
      ],
      minimalExampleInput: {
        apiId: 'kaggle',
        endpointId: 'download_competition_data_file',
        params: { competitionName: 'playground-series-s6e7', fileName: 'train.csv' },
        toMemoryPath: '/workspace/data/playground-series-s6e7/train.csv',
        indexing: 'disabled',
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: ApiHttpDownloadInputSchema,
    outputZod: ApiHttpDownloadOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // API Definition Management (api.definition.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'api',
    group: 'definition',
    verb: 'upsert',
    name: 'Upsert API Definition',
    actionLabel: 'Saving API definition…',
    semanticDescription:
      'Create an API definition, or merge endpoint changes into an existing one. ' +
      'Endpoints merge by endpointId — send only what you are adding or changing; ' +
      'removal is explicit via removeEndpointIds.',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_definition', action: 'create' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Register an API definition, or merge endpoint changes into an existing one. ' +
        'After this: 1) user stores credential value via Integrations page, ' +
        '2) create a binding (api.binding.upsert) to connect definition + credential + egress policy.',
      whenToUse: [
        'Registering a new external API for use in flows',
        'Adding or fixing endpoints on an existing definition — send only the endpoints you are changing',
      ],
      whenNotToUse: [
        'Importing from an OpenAPI spec — use api.definition.import_openapi',
        'Changing only baseUrl, name, or auth — use api.definition.patch instead',
      ],
      pitfalls: [
        'For a vendor with a published OpenAPI/Swagger spec, prefer api.definition.import_openapi — ' +
          'it fetches the spec server-side (no truncation), filters by tags/operationIds, merges by ' +
          'endpointId, and supports dryRun. Hand-copying paths from doc pages is the top source of 404s.',
        'NEVER suggest using CLI tools (pip packages, npm packages) inside a compute sandbox for API access. ' +
          'The sandbox has no network access and no credentials. Always use api.http.call for API requests, ' +
          'then pipe data to the sandbox via inputPaths.',
        'If the API redirects to other hosts (e.g., file downloads redirecting to CDN/GCS), ' +
          'set suggestedEgressPolicy with allowCrossHostRedirects: true and list the redirect hosts ' +
          'in additionalHosts. This ensures bindings are created correctly by default.',
        'For file download APIs, set suggestedEgressPolicy.minResponseBodyBytes to handle large files ' +
          '(e.g., 104857600 for 100 MB) and minTimeoutMs to 60000 or higher.',
      ],
      minimalExampleInput: {
        apiId: 'my-api',
        name: 'My API',
        baseUrl: 'https://api.example.com',
        endpoints: [
          {
            endpointId: 'get_items',
            name: 'List Items',
            method: 'GET',
            pathTemplate: '/items',
            description: 'List all items',
          },
        ],
        suggestedEgressPolicy: {
          allowCrossHostRedirects: true,
          additionalHosts: ['cdn.example.com'],
          minResponseBodyBytes: 104_857_600,
        },
      },
      followUp: [
        {
          operationId: 'api.binding.upsert',
          note: 'Create a binding to connect this API definition with credentials and egress policy',
          condition: 'when_available',
        },
        {
          operationId: 'api.binding.test',
          note: 'Verify definition + binding + credential + egress resolve before calling',
          condition: 'when_available',
        },
        {
          operationId: 'api.definition.list',
          note: 'List all registered API definitions',
          condition: 'when_available',
        },
        {
          operationId: 'catalog.tool.search',
          note: 'Search for API endpoints to use',
          condition: 'always',
        },
      ],
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformApiUpsertDefinitionInputSchema,
    outputZod: PlatformApiUpsertDefinitionOutputSchema,
  },
  {
    stepType: 'api',
    group: 'definition',
    verb: 'patch',
    name: 'Patch API Definition',
    actionLabel: 'Patching API definition…',
    semanticDescription:
      'Partially update an API definition — change baseUrl, name, tags, or auth without re-sending all endpoints. ' +
      'Only provided fields are updated; omitted fields remain unchanged.',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_definition', action: 'update' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Partially update an API definition. Change baseUrl, name, tags, or auth without re-sending endpoints.',
      whenToUse: [
        'Changing just the base URL of an API definition',
        'Updating the name, description, tags, or auth without re-sending endpoints',
      ],
      whenNotToUse: [
        'Adding or modifying endpoints — use api.definition.upsert (merges by endpointId)',
        'Creating a new API definition — use api.definition.upsert',
      ],
      pitfalls: [
        'Endpoints are NOT patchable here — api.definition.upsert merges endpoint changes by endpointId',
        'Only top-level fields can be patched (baseUrl, name, description, tags, auth, defaultHeaders)',
      ],
      minimalExampleInput: {
        apiId: 'my-api',
        baseUrl: 'https://api-v2.example.com',
      },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformApiPatchDefinitionInputSchema,
    outputZod: PlatformApiPatchDefinitionOutputSchema,
  },
  {
    stepType: 'api',
    group: 'definition',
    verb: 'delete',
    name: 'Delete API Definition',
    actionLabel: 'Deleting API definition…',
    semanticDescription: 'Delete an API definition by ID',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_definition', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete an API definition by ID.',
      whenToUse: ['Removing an API that is no longer used'],
      whenNotToUse: ['API still has active bindings — delete bindings first'],
      minimalExampleInput: { apiId: 'github' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformApiDeleteDefinitionInputSchema,
    outputZod: PlatformApiDeleteDefinitionOutputSchema,
  },
  {
    stepType: 'api',
    group: 'definition',
    verb: 'get',
    name: 'Get API Definition',
    actionLabel: 'Fetching API definition…',
    semanticDescription: 'Retrieve a full API definition including endpoints by API ID',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_definition', action: 'read' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve an API definition with its endpoints.',
      whenToUse: [
        'Inspecting endpoint details before calling an API',
        'Reviewing the full definition of a registered API',
      ],
      whenNotToUse: ['Listing all APIs — use api.definition.list'],
      minimalExampleInput: { apiId: 'github' },
    },
    accessMode: 'read',
    inputZod: PlatformApiGetDefinitionInputSchema,
    outputZod: PlatformApiGetDefinitionOutputSchema,
  },
  {
    stepType: 'api',
    group: 'definition',
    verb: 'list',
    name: 'List Available APIs',
    actionLabel: 'Listing available APIs…',
    semanticDescription:
      'Discover which APIs are registered and available to call. ' +
      'Returns API names, endpoints, parameter schemas, and tags — no secrets or credentials. ' +
      'Always check this first to see what integrations exist (e.g., GitHub, Stripe, internal APIs) before calling api.http.call.',
    tags: ['catalog', 'api', 'agent', 'discovery'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Discover registered API integrations and their endpoints. ' +
        'Use before api.http.call to find what APIs are available.',
      whenToUse: [
        'Finding out what APIs/integrations are available (e.g., error APIs, payment APIs, etc.)',
        'Discovering endpoint details before making api.http.call',
      ],
      whenNotToUse: ['Fetching a single API by ID — use api.definition.get'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: PlatformListApiDefinitionsInputSchema,
    outputZod: PlatformListApiDefinitionsOutputSchema,
  },
  {
    stepType: 'api',
    group: 'definition',
    verb: 'import_openapi',
    name: 'Import OpenAPI Spec',
    actionLabel: 'Importing OpenAPI spec…',
    semanticDescription:
      'Import an OpenAPI specification (JSON) to populate an API definition with endpoints. ' +
      'Supports filtering by tags or operationIds, additive merge, and optional pruning of absent endpoints. ' +
      'Returns a diff summary of added, updated, removed, and unchanged endpoints.',
    tags: ['crud', 'api', 'import'],
    crudView: { entityType: 'api_definition', action: 'update' },
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Import endpoints from an OpenAPI spec into an API definition.',
      whenToUse: [
        'Bootstrapping an API definition from an existing OpenAPI/Swagger spec',
        'Syncing endpoint changes from an updated spec',
      ],
      whenNotToUse: ['Manually defining a few endpoints — use api.definition.upsert'],
      pitfalls: [
        'Provide exactly one of specUrl or specInline, not both',
        'pruneAbsent removes endpoints not in the new spec — use with care',
        'Set dryRun: true to preview changes without persisting — useful for verifying import results first',
      ],
      minimalExampleInput: {
        apiId: 'github',
        specUrl:
          'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
      },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformApiImportOpenApiInputSchema,
    outputZod: PlatformApiImportOpenApiOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // API Binding Management (api.binding.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'api',
    group: 'binding',
    verb: 'upsert',
    name: 'Upsert API Binding',
    actionLabel: 'Saving API binding…',
    semanticDescription:
      'Create or update a scoped API binding with auth profile, egress policy and fulfillment mode ' +
      '(no secrets — credential key references only). A binding with fulfillment.mode "simulated" ' +
      'names a simulation that answers its endpoints without a host, a credential or a network call.',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_binding', action: 'create' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Create or update an API binding with auth and egress settings. ' +
        'After creating an API definition and storing credentials, this binds them together with egress policy.',
      whenToUse: [
        'Connecting an API definition to a tenant/space with credentials',
        'Updating auth or egress policy for an existing binding',
      ],
      whenNotToUse: ['The API definition does not exist yet — create it first'],
      pitfalls: [
        'auth.type must be exactly one of: "none", "bearer", "basic", "api_key", ' +
          '"oauth2_client_credentials", "oauth2_authorization_code". OAuth authorization-code ' +
          'profiles are created by connector install/consent — when updating such a binding, omit ' +
          'auth rather than switching types; a type change discards the stored OAuth profile.',
        'On an UPDATE, omit auth entirely unless you are changing the auth scheme — the stored ' +
          'profile including its credential keys is preserved. Re-sending the same type inherits ' +
          'every stored profile field you do not explicitly set. You CANNOT set credential VALUES ' +
          'from here — the operator configures those in the Integrations page.',
        'The result echoes credentialStatus — anything but "ready" means calls will fail and the ' +
          "binding's endpoints will not promote as tools until credentials are configured.",
        'File download APIs often redirect to CDN/storage hosts. If you get empty responses or redirect errors, set ' +
          'egressPolicy.allowCrossHostRedirects: true and add the redirect target host to allowedHosts.',
        'egressPolicy.allowedHosts is auto-derived from the API definition baseUrl if omitted. ' +
          'If the definition has suggestedEgressPolicy, those hints are also merged as defaults.',
        'For large file downloads/uploads, increase maxResponseBodyBytes (up to 500 MB) and timeoutMs (up to 300s).',
        'fulfillment is preserved when omitted, so an unrelated update never silently flips a ' +
          'simulated binding live. A simulated binding must name a simulation that exists in this ' +
          'space and targets this same apiId, on an endpoint-mode definition — otherwise the write ' +
          'is rejected with the exact violations.',
        'Creating a binding does NOT put its tools on any agent. Which integrations an agent ' +
          'carries is an operator choice made under Connections, so a binding you just created ' +
          'stays unreachable — including to you — until it is enabled there. A promote that ' +
          'refuses with "not_in_grant: integration ... not in this task\'s allowlist" is this, ' +
          'not a broken binding: say which connection needs enabling rather than reporting the ' +
          'integration as unavailable.',
      ],
      minimalExampleInput: {
        bindingId: 'my-api-default',
        apiId: 'my-api',
        name: 'My API binding',
        scope: { tenantId: '<your-tenant-id from FlowRunContext>' },
        auth: { type: 'bearer' },
        egressPolicy: { allowedHosts: ['api.example.com'] },
      },
      followUp: [
        {
          operationId: 'api.binding.test',
          note: 'Verify definition + binding + credential + egress resolve before calling',
          condition: 'when_available',
        },
        {
          operationId: 'api.http.call',
          note: 'Call an endpoint from the bound API',
          condition: 'when_available',
        },
        {
          operationId: 'catalog.tool.search',
          note: "Search for this API's endpoints to call them as tools",
          condition: 'always',
        },
      ],
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformApiUpsertBindingInputSchema,
    outputZod: PlatformApiUpsertBindingOutputSchema,
  },
  {
    stepType: 'api',
    group: 'binding',
    verb: 'delete',
    name: 'Delete API Binding',
    actionLabel: 'Deleting API binding…',
    semanticDescription: 'Delete an API binding by ID',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_binding', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete an API binding by ID.',
      whenToUse: ['Removing a binding that is no longer needed', 'Revoking API access for a scope'],
      whenNotToUse: ['Disabling temporarily — update the binding with enabled: false instead'],
      minimalExampleInput: { bindingId: 'github-prod' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformApiDeleteBindingInputSchema,
    outputZod: PlatformApiDeleteBindingOutputSchema,
  },
  {
    stepType: 'api',
    group: 'binding',
    verb: 'get',
    name: 'Get API Binding',
    actionLabel: 'Fetching API binding…',
    semanticDescription:
      'Retrieve an API binding by ID, including scope, auth type, credential keys, and egress policy',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_binding', action: 'read' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve an API binding with scope and auth details.',
      whenToUse: ['Inspecting binding configuration for debugging or auditing'],
      whenNotToUse: ['Listing all bindings — use api.binding.list'],
      pitfalls: [
        'bindingId is NOT the same as apiId. Bindings typically follow the convention "{apiId}-default" ' +
          '(e.g., "github-default" for apiId "github"). You can also pass the apiId directly — the platform ' +
          'will fall back to finding the first binding for that API.',
        'Use api.binding.list if you are unsure of the binding ID.',
      ],
      minimalExampleInput: { bindingId: 'github-default' },
    },
    accessMode: 'read',
    inputZod: PlatformApiGetBindingInputSchema,
    outputZod: PlatformApiGetBindingOutputSchema,
  },
  {
    stepType: 'api',
    group: 'binding',
    verb: 'list',
    name: 'List API Bindings',
    actionLabel: 'Listing API bindings…',
    semanticDescription:
      'List API bindings, optionally filtered by API ID. Returns binding summaries with scope and enabled status.',
    tags: ['crud', 'api'],
    crudView: { entityType: 'api_binding', action: 'list' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List API bindings with optional filtering by API ID.',
      whenToUse: [
        'Discovering which bindings exist for an API',
        'Auditing active bindings across scopes',
      ],
      whenNotToUse: ['Fetching a single binding — use api.binding.get'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: PlatformApiListBindingsInputSchema,
    outputZod: PlatformApiListBindingsOutputSchema,
  },
  {
    stepType: 'api',
    group: 'binding',
    verb: 'test',
    name: 'Test API Binding',
    actionLabel: 'Testing API binding…',
    semanticDescription:
      'Run diagnostic checks on an API binding without making a real API call. ' +
      'Validates that the definition exists, endpoint is found, binding is resolved, ' +
      'credential is configured, and the target host passes egress policy.',
    tags: ['api', 'diagnostic'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Test that an API binding is correctly configured — checks definition, credentials, and egress policy without making a real call.',
      whenToUse: [
        'Verifying a newly created binding before making api.http.call',
        'Debugging why an API call fails with credential or egress errors',
      ],
      whenNotToUse: ['Actually calling the API — use api.http.call'],
      pitfalls: [
        'Does not make a real HTTP request — only validates configuration',
        'Credential check verifies the key exists but does not validate the token value',
      ],
      minimalExampleInput: { apiId: 'my-api' },
    },
    accessMode: 'read',
    inputZod: PlatformApiBindingTestInputSchema,
    outputZod: PlatformApiBindingTestOutputSchema,
  },
];
