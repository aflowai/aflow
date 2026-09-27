import type { SkillBundleId, SkillBundleInput } from '@aflow/schemas';
import { POLYGON_CONNECTOR } from '../connectorCatalog/polygon.js';
import { NEWSAPI_CONNECTOR } from '../connectorCatalog/newsapi.js';
import { bundledApiDefinitionFromConnector } from './connectorApiDefinitions.js';
import { TICKER_DIGEST_CARD_SEED } from './tickerDigestArtifactSeed.js';

const POLYGON_API_KEY_CREDENTIAL = 'polygon-api-key';
const NEWSAPI_KEY_CREDENTIAL = 'newsapi-api-key';

export const TICKER_DIGEST: SkillBundleInput = {
  bundleId: 'ticker-digest' as SkillBundleId,
  version: 4,
  name: 'Ticker Digest',
  tagline: 'One-ticker market digest: price trend, sourced news, watch items, inline card.',
  description: `Wires up the **Polygon.io** and **NewsAPI** integrations and the **Ticker Market Digest** skill — ask for a digest of any ticker and get an inline card: price summary and ~30-day trend from fetched daily bars, up to 12 news items merged from Polygon's ticker feed and a NewsAPI keyword search (every item carrying its real article URL), concrete watch items, and a short prose brief quoting the numbers.

**What you get**:
- The **Polygon.io** API definition (previous close, aggregate bars, ticker details, ticker news) + a default binding ready for your Polygon API key (sent as the apiKey query parameter).
- The **NewsAPI** definition (article search) + a default binding ready for your NewsAPI key.
- The **Ticker Market Digest** skill — previous close fetched deterministically, evidence gathered with honest gap-reporting, the digest composed against a typed contract, and the bundled card rendered inline.
- The **digest card** artifact the skill renders — seeded with the exact data schema the compose step is held to.

**After install**:
1. Go to **Integrations → API integrations** and paste your **Polygon.io API key** (polygon.io → API Keys; free tier is enough — the skill uses end-of-day data) and your **NewsAPI key** (newsapi.org → Get API Key).
2. Ask for a digest — "market digest for AAPL", optionally with a focus note ("focus on the earnings reaction"). One run digests one ticker.`,
  tags: ['market-data', 'news', 'stocks', 'digest', 'research'],
  skillCatalogIds: ['ticker-market-digest'],
  prerequisiteBundleIds: [],
  apiDefinitions: [
    bundledApiDefinitionFromConnector(POLYGON_CONNECTOR),
    bundledApiDefinitionFromConnector(NEWSAPI_CONNECTOR),
  ],
  apiBindingTemplates: [
    {
      bindingId: 'polygon-default',
      apiId: 'polygon',
      name: 'Default',
      description:
        'Read-only Polygon.io market data: previous close, daily aggregate bars, ticker reference details, ticker news. Paste your Polygon API key as the credential; it is sent as the apiKey query parameter.',
      authShape: {
        type: 'api_key' as const,
        placement: 'query' as const,
        queryParamName: 'apiKey',
      },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: POLYGON_API_KEY_CREDENTIAL,
          role: 'api_key' as const,
          label: 'Polygon API key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['api.polygon.io'],
        allowedMethods: ['GET' as const],
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'newsapi-default',
      apiId: 'newsapi',
      name: 'Default',
      description:
        'Read-only NewsAPI article search. Paste your NewsAPI key as the credential; it is sent as the X-API-Key header.',
      authShape: {
        type: 'api_key' as const,
        placement: 'header' as const,
        headerName: 'X-API-Key',
      },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: NEWSAPI_KEY_CREDENTIAL,
          role: 'api_key' as const,
          label: 'NewsAPI key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['newsapi.org'],
        allowedMethods: ['GET' as const],
      },
      conflictPolicy: 'skip' as const,
    },
  ],
  memorySeed: [],
  artifactSeed: [TICKER_DIGEST_CARD_SEED],
  helmsmanHints: [
    'After install, go to Integrations → API integrations and paste the Polygon.io API key (apiKey query param) and the NewsAPI key (X-API-Key header) — one credential each.',
    'One run digests ONE ticker: start the ticker-market-digest workflow with input { ticker } (uppercase symbol) plus an optional { focus } note. For several tickers, start one run per ticker.',
    'The digest card mounted by the run IS the deliverable — relay its brief and any coverage gaps the run reports; do not re-narrate the card’s numbers in prose.',
  ],
};
