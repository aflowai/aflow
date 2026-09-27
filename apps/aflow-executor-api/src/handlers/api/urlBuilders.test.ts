import { describe, expect, it } from 'vitest';
import type { ApiDefinition, ApiEndpoint } from '@aflow/schemas';
import { buildEndpointUrl } from './urlBuilders.js';

const ALPACA_DATA: ApiDefinition = {
  apiId: 'alpaca-data',
  name: 'Alpaca Market Data',
  baseUrl: 'https://data.alpaca.markets',
  version: '1',
  endpoints: [],
  tags: [],
  source: 'custom',
};

function alpacaWith(endpoint: ApiEndpoint): ApiDefinition {
  return { ...ALPACA_DATA, endpoints: [endpoint] };
}

describe('buildEndpointUrl — query-param serialization', () => {
  it('serializes a query-only endpoint to a baseUrl + path + ?key=value URL', () => {
    const news: ApiEndpoint = {
      endpointId: 'get_v1beta1_news',
      name: 'Fetch news',
      method: 'GET',
      pathTemplate: '/v1beta1/news',
      params: [
        { name: 'symbols', location: 'query', required: true },
        { name: 'limit', location: 'query', required: false },
      ],
      tags: [],
    };
    const url = buildEndpointUrl(
      alpacaWith(news),
      news,
      { symbols: 'AAPL,MSFT', limit: 10 },
      undefined,
    );
    expect(url).toBe('https://data.alpaca.markets/v1beta1/news?symbols=AAPL%2CMSFT&limit=10');
  });

  it('omits query params that are absent from the caller-supplied params record', () => {
    // Required-ness is enforced only for path params today — query-side
    // omission is silent. This documents the current behavior so a future
    // refactor that tightens it doesn't pass invisibly.
    const news: ApiEndpoint = {
      endpointId: 'get_v1beta1_news',
      name: 'Fetch news',
      method: 'GET',
      pathTemplate: '/v1beta1/news',
      params: [
        { name: 'symbols', location: 'query', required: true },
        { name: 'limit', location: 'query', required: false },
      ],
      tags: [],
    };
    const url = buildEndpointUrl(alpacaWith(news), news, { symbols: 'AAPL' }, undefined);
    expect(url).toBe('https://data.alpaca.markets/v1beta1/news?symbols=AAPL');
  });

  it('serializes a mixed path + query endpoint with all params populated', () => {
    const bars: ApiEndpoint = {
      endpointId: 'get_v2_stocks_symbol_bars',
      name: 'Historical bars',
      method: 'GET',
      pathTemplate: '/v2/stocks/{symbol}/bars',
      params: [
        { name: 'symbol', location: 'path', required: true },
        { name: 'timeframe', location: 'query', required: true },
        { name: 'start', location: 'query', required: false },
        { name: 'end', location: 'query', required: false },
      ],
      tags: [],
    };
    const url = buildEndpointUrl(
      alpacaWith(bars),
      bars,
      {
        symbol: 'AAPL',
        timeframe: '1Day',
        start: '2026-01-01',
        end: '2026-01-31',
      },
      undefined,
    );
    expect(url).toBe(
      'https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=1Day&start=2026-01-01&end=2026-01-31',
    );
  });

  it('substitutes path params and omits missing optional query params on a mixed endpoint', () => {
    const bars: ApiEndpoint = {
      endpointId: 'get_v2_stocks_symbol_bars',
      name: 'Historical bars',
      method: 'GET',
      pathTemplate: '/v2/stocks/{symbol}/bars',
      params: [
        { name: 'symbol', location: 'path', required: true },
        { name: 'timeframe', location: 'query', required: true },
        { name: 'start', location: 'query', required: false },
        { name: 'end', location: 'query', required: false },
      ],
      tags: [],
    };
    const url = buildEndpointUrl(
      alpacaWith(bars),
      bars,
      { symbol: 'AAPL', timeframe: '1Day' },
      undefined,
    );
    expect(url).toBe('https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=1Day');
  });

  it('regression-safety: a path-param-only endpoint produces a URL with no querystring', () => {
    const leaderboard: ApiEndpoint = {
      endpointId: 'get_competitions_id_leaderboard_download',
      name: 'Fetch leaderboard',
      method: 'GET',
      pathTemplate: '/competitions/{id}/leaderboard/download',
      params: [{ name: 'id', location: 'path', required: true }],
      tags: [],
    };
    const definition: ApiDefinition = {
      ...ALPACA_DATA,
      apiId: 'kaggle',
      name: 'Kaggle',
      baseUrl: 'https://www.kaggle.com/api/v1',
      endpoints: [leaderboard],
    };
    const url = buildEndpointUrl(definition, leaderboard, { id: 42 }, undefined);
    expect(url).toBe('https://www.kaggle.com/api/v1/competitions/42/leaderboard/download');
    expect(url).not.toContain('?');
  });
});

describe('buildEndpointUrl — baseUrlTemplate variable substitution', () => {
  const jiraSearch: ApiEndpoint = {
    endpointId: 'get_search',
    name: 'Search issues',
    method: 'GET',
    pathTemplate: '/rest/api/3/search',
    params: [{ name: 'jql', location: 'query', required: true }],
    tags: [],
  };
  const jira: ApiDefinition = {
    apiId: 'jira',
    name: 'JIRA',
    baseUrlTemplate: 'https://{domain}.atlassian.net',
    variables: [{ name: 'domain', description: 'JIRA site subdomain', required: true }],
    version: '1',
    endpoints: [jiraSearch],
    tags: [],
    source: 'custom',
  };

  it('substitutes a declared template variable from variableValues into the host', () => {
    const url = buildEndpointUrl(jira, jiraSearch, { jql: 'project=ABC' }, { domain: 'acme' });
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/search?jql=project%3DABC');
  });

  it('throws when a required template variable is unfilled', () => {
    expect(() => buildEndpointUrl(jira, jiraSearch, { jql: 'x' }, {})).toThrow(
      /needs configuration/,
    );
  });
});

describe('buildEndpointUrl — param defaultValue injection', () => {
  const withParams = (params: ApiEndpoint['params'], pathTemplate = '/v1/query'): ApiEndpoint => ({
    endpointId: 'ep',
    name: 'ep',
    method: 'GET',
    pathTemplate,
    params,
    tags: [],
  });

  it('injects a query defaultValue when the caller omits the param', () => {
    const endpoint = withParams([
      { name: 'since', location: 'query', required: false, defaultValue: '-7d' },
    ]);
    const url = buildEndpointUrl(alpacaWith(endpoint), endpoint, {}, undefined);
    expect(url).toBe('https://data.alpaca.markets/v1/query?since=-7d');
  });

  it('lets an explicit caller value win over the defaultValue', () => {
    const endpoint = withParams([
      { name: 'since', location: 'query', required: false, defaultValue: '-7d' },
    ]);
    const url = buildEndpointUrl(alpacaWith(endpoint), endpoint, { since: '-30d' }, undefined);
    expect(url).toBe('https://data.alpaca.markets/v1/query?since=-30d');
  });

  it('injects a path defaultValue when the caller omits the param', () => {
    const endpoint = withParams(
      [{ name: 'dataset', location: 'path', required: true, defaultValue: 'visits' }],
      '/v1/query/{dataset}/count',
    );
    const url = buildEndpointUrl(alpacaWith(endpoint), endpoint, {}, undefined);
    expect(url).toBe('https://data.alpaca.markets/v1/query/visits/count');
  });
});
