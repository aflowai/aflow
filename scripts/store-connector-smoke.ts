/**
 * Live smoke for a store connector — the manual credentialed lane, never CI.
 *
 * Resolves the listing from the connector registry, reads credentials from
 * SMOKE_<CATALOGID>_<SLOT> env vars (slots by authKind: bearer→TOKEN,
 * api_key→KEY, basic→USERNAME+PASSWORD; baseUrlTemplate variables via
 * SMOKE_<CATALOGID>_VAR_<NAME>), executes the connector's designated read
 * endpoints against the live API, and prints a pass/fail table. A failing
 * smoke drops the listing to hidden until it passes again.
 *
 * This is REQUEST-level smoke: requests are built straight from the listing
 * definition with env credentials. The install-level path (space install,
 * binding, credential fill, executor call) is not exercised here.
 *
 * Only endpoints declared in SMOKE_TARGETS run: GETs, plus POSTs whose table
 * entry declares a sampleBody (pinned `const` body fields are auto-filled from
 * the endpoint schema). Keep every target a read-only operation.
 *
 * Run: NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/store-connector-smoke.ts <catalogId>
 */
import { getConnectorCatalogEntry } from '@aflow/platform-artifacts';
import type { ApiEndpoint, ConnectorCatalogEntry } from '@aflow/schemas';

const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
if (
  !nodeOptions.includes('ts-source') &&
  !process.execArgv.some((arg) => arg.includes('ts-source'))
) {
  console.error(
    'Refusing to smoke prebuilt dist content — it may not match the registry source. Re-run as:\n' +
      "  NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/store-connector-smoke.ts <catalogId>",
  );
  process.exit(1);
}

interface SmokeTarget {
  endpointId: string;
  sampleParams: Record<string, string | number | boolean>;
  sampleBody?: Record<string, unknown>;
}

const SMOKE_TARGETS: Readonly<Record<string, readonly SmokeTarget[]>> = {
  github: [
    {
      endpointId: 'listPullRequests',
      sampleParams: { owner: 'octocat', repo: 'Hello-World', state: 'all', per_page: 1 },
    },
  ],
  'jira-cloud': [{ endpointId: 'listProjects', sampleParams: { maxResults: 1 } }],
  notion: [{ endpointId: 'search', sampleParams: {}, sampleBody: { page_size: 1 } }],
  linear: [{ endpointId: 'listTeams', sampleParams: {}, sampleBody: { variables: { first: 1 } } }],
  airtable: [{ endpointId: 'listBases', sampleParams: {} }],
  polygon: [
    { endpointId: 'getMarketStatus', sampleParams: {} },
    { endpointId: 'getPreviousClose', sampleParams: { ticker: 'AAPL' } },
  ],
  newsapi: [
    { endpointId: 'listSources', sampleParams: { language: 'en' } },
    { endpointId: 'getTopHeadlines', sampleParams: { country: 'us', pageSize: 1 } },
  ],
  'brave-search': [{ endpointId: 'webSearch', sampleParams: { q: 'test', count: 1 } }],
  firecrawl: [
    { endpointId: 'scrape', sampleParams: {}, sampleBody: { url: 'https://example.com' } },
  ],
  resend: [{ endpointId: 'listDomains', sampleParams: {} }],
  stripe: [{ endpointId: 'getBalance', sampleParams: {} }],
  twilio: [{ endpointId: 'listMessages', sampleParams: { PageSize: 1 } }],
  wikipedia: [
    {
      endpointId: 'search',
      sampleParams: {
        action: 'query',
        format: 'json',
        list: 'search',
        srsearch: 'test',
        srlimit: 1,
      },
    },
  ],
  arxiv: [
    { endpointId: 'searchPapers', sampleParams: { search_query: 'all:test', max_results: 1 } },
  ],
  pubmed: [{ endpointId: 'esearch', sampleParams: { term: 'cancer', retmode: 'json', retmax: 1 } }],
  'semantic-scholar': [
    {
      endpointId: 'searchPapers',
      sampleParams: { query: 'machine learning', limit: 1, fields: 'title' },
    },
  ],
  'world-bank': [{ endpointId: 'listCountries', sampleParams: { format: 'json', per_page: 1 } }],
  fred: [{ endpointId: 'getSeries', sampleParams: { series_id: 'GDP', file_type: 'json' } }],
  openweather: [
    { endpointId: 'getCurrentWeather', sampleParams: { q: 'London', units: 'metric' } },
  ],
};

function envSlotPrefix(catalogId: string): string {
  return `SMOKE_${catalogId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`Missing env var ${name}.`);
    process.exit(1);
  }
  return value;
}

interface SmokeAuth {
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}

function buildAuth(entry: ConnectorCatalogEntry, prefix: string): SmokeAuth {
  const none: SmokeAuth = { headers: {}, queryParams: {} };
  switch (entry.authKind) {
    case 'none':
      return none;
    case 'bearer':
      return {
        headers: { Authorization: `Bearer ${requireEnv(`${prefix}_TOKEN`)}` },
        queryParams: {},
      };
    case 'api_key':
      // Placement mirrors the connector listing: a query-param name → the key
      // rides the query string; otherwise the header form (default X-API-Key).
      return entry.apiKeyQueryParamName !== undefined
        ? {
            headers: {},
            queryParams: { [entry.apiKeyQueryParamName]: requireEnv(`${prefix}_KEY`) },
          }
        : {
            headers: { [entry.apiKeyHeaderName ?? 'X-API-Key']: requireEnv(`${prefix}_KEY`) },
            queryParams: {},
          };
    case 'api_key_pair': {
      const pair = entry.apiKeyPairHeaderNames;
      if (pair === undefined) {
        console.error(`Connector ${entry.catalogId} is api_key_pair but declares no header names.`);
        process.exit(1);
      }
      return {
        headers: {
          [pair.primary]: requireEnv(`${prefix}_KEY`),
          [pair.secondary]: requireEnv(`${prefix}_SECONDARY_KEY`),
        },
        queryParams: {},
      };
    }
    case 'basic': {
      const username = requireEnv(`${prefix}_USERNAME`);
      const password = requireEnv(`${prefix}_PASSWORD`);
      return {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        },
        queryParams: {},
      };
    }
    case 'oauth2_authorization_code':
      console.error(
        `Connector '${entry.catalogId}' uses OAuth consent — smoke it through an installed ` +
          'space binding, not this env-credential lane.',
      );
      process.exit(1);
  }
}

function resolveBaseUrl(entry: ConnectorCatalogEntry, prefix: string): string {
  const { definition } = entry;
  if (definition.baseUrl !== undefined) return definition.baseUrl;
  let url = definition.baseUrlTemplate ?? '';
  for (const variable of definition.variables ?? []) {
    const value = requireEnv(`${prefix}_VAR_${variable.name.toUpperCase()}`);
    url = url.replaceAll(`{${variable.name}}`, value);
  }
  return url;
}

function buildRequestUrl(
  baseUrl: string,
  endpoint: ApiEndpoint,
  sampleParams: Record<string, string | number | boolean>,
  authQueryParams: Record<string, string>,
): string {
  let path = endpoint.pathTemplate;
  for (const param of endpoint.params) {
    if (param.location !== 'path') continue;
    const value = sampleParams[param.name];
    if (value === undefined) {
      throw new Error(
        `Smoke target for '${endpoint.endpointId}' misses path param '${param.name}'.`,
      );
    }
    path = path.replaceAll(`{${param.name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`);
  for (const param of endpoint.params) {
    if (param.location !== 'query') continue;
    const value = sampleParams[param.name];
    if (value !== undefined) url.searchParams.set(param.name, String(value));
  }
  for (const [name, value] of Object.entries(authQueryParams)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

interface SmokeResult {
  endpointId: string;
  status: number | null;
  ok: boolean;
  detail: string;
}

function buildSampleBody(
  endpoint: ApiEndpoint,
  sampleBody: Record<string, unknown>,
): Record<string, unknown> {
  const bodyParam = endpoint.params.find((param) => param.location === 'body');
  const properties = (bodyParam?.schema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const pinned: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(properties ?? {})) {
    const constValue = (propSchema as { const?: unknown }).const;
    if (constValue !== undefined) pinned[key] = constValue;
  }
  return { ...pinned, ...sampleBody };
}

async function smokeEndpoint(
  entry: ConnectorCatalogEntry,
  target: SmokeTarget,
  baseUrl: string,
  auth: SmokeAuth,
): Promise<SmokeResult> {
  const endpoint = entry.definition.endpoints.find((ep) => ep.endpointId === target.endpointId);
  if (!endpoint) {
    return {
      endpointId: target.endpointId,
      status: null,
      ok: false,
      detail: 'endpoint not found in definition',
    };
  }
  const sampleBody = endpoint.method === 'POST' ? target.sampleBody : undefined;
  if (endpoint.method !== 'GET' && !(endpoint.method === 'POST' && sampleBody !== undefined)) {
    return {
      endpointId: target.endpointId,
      status: null,
      ok: false,
      detail: 'smoke lane only executes GETs and POSTs declared with a sampleBody',
    };
  }
  try {
    const url = buildRequestUrl(baseUrl, endpoint, target.sampleParams, auth.queryParams);
    const response = await fetch(url, {
      method: endpoint.method,
      headers: {
        ...entry.definition.defaultHeaders,
        ...auth.headers,
        ...(sampleBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(sampleBody !== undefined
        ? { body: JSON.stringify(buildSampleBody(endpoint, sampleBody)) }
        : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    return {
      endpointId: target.endpointId,
      status: response.status,
      ok: response.ok,
      detail: response.ok ? `${body.length} bytes` : body.slice(0, 200),
    };
  } catch (err) {
    return {
      endpointId: target.endpointId,
      status: null,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const catalogId = process.argv[2];
  if (!catalogId) {
    console.error('Usage: store-connector-smoke.ts <catalogId>');
    console.error(`Known smoke targets: ${Object.keys(SMOKE_TARGETS).join(', ')}`);
    process.exit(1);
  }
  const entry = getConnectorCatalogEntry(catalogId);
  if (!entry) {
    console.error(`Unknown connector '${catalogId}' — not in the connector catalog.`);
    process.exit(1);
  }
  const targets = SMOKE_TARGETS[catalogId];
  if (!targets || targets.length === 0) {
    console.error(`No smoke targets declared for '${catalogId}'. Add them to SMOKE_TARGETS.`);
    process.exit(1);
  }

  const prefix = envSlotPrefix(catalogId);
  const auth = buildAuth(entry, prefix);
  const baseUrl = resolveBaseUrl(entry, prefix);

  console.log(`Smoking '${catalogId}' (${entry.name}) against ${baseUrl}\n`);
  const results: SmokeResult[] = [];
  for (const target of targets) {
    results.push(await smokeEndpoint(entry, target, baseUrl, auth));
  }

  for (const result of results) {
    const verdict = result.ok ? 'PASS' : 'FAIL';
    const status = result.status === null ? '—' : String(result.status);
    console.log(
      `  ${verdict}  ${result.endpointId.padEnd(24)} ${status.padEnd(4)} ${result.detail}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
