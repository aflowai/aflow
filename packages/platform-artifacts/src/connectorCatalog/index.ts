import { ConnectorCatalogEntrySchema, type ConnectorCatalogEntry } from '@aflow/schemas';

import { JIRA_CONNECTOR } from './jira.js';
import { GITHUB_CONNECTOR } from './github.js';
import { POLYGON_CONNECTOR } from './polygon.js';
import { NEWSAPI_CONNECTOR } from './newsapi.js';
import { NOTION_CONNECTOR } from './notion.js';
import { LINEAR_CONNECTOR } from './linear.js';
import { AIRTABLE_CONNECTOR } from './airtable.js';
import { STRIPE_CONNECTOR } from './stripe.js';
import { TWILIO_CONNECTOR } from './twilio.js';
import { BRAVE_CONNECTOR } from './brave.js';
import { FIRECRAWL_CONNECTOR } from './firecrawl.js';
import { RESEND_CONNECTOR } from './resend.js';
import { SEMANTIC_SCHOLAR_CONNECTOR } from './semanticscholar.js';
import { WORLD_BANK_CONNECTOR } from './worldbank.js';
import { WIKIPEDIA_CONNECTOR } from './wikipedia.js';
import { ARXIV_CONNECTOR } from './arxiv.js';
import { SIMULATED_EXAMPLE_CONNECTOR } from './simulatedExample.js';
import { BNPL_CORE_CONNECTOR } from './bnplCore.js';
import { PUBMED_CONNECTOR } from './pubmed.js';
import { FRED_CONNECTOR } from './fred.js';
import { OPENWEATHER_CONNECTOR } from './openweather.js';
import { SLACK_CONNECTOR } from './slack.js';
import { VERCEL_CONNECTOR } from './vercel.js';
import { SENTRY_CONNECTOR } from './sentry.js';
import { CLOUDFLARE_CONNECTOR } from './cloudflare.js';
import { GOOGLE_SHEETS_CONNECTOR } from './googlesheets.js';
import { GMAIL_CONNECTOR } from './gmail.js';
import { GOOGLE_CALENDAR_CONNECTOR } from './googlecalendar.js';
import { ETORO_MARKET_DATA_CONNECTOR } from './etoroMarketData.js';
import { ETORO_ACCOUNT_CONNECTOR } from './etoroAccount.js';
import { ETORO_TRADING_CONNECTOR } from './etoroTrading.js';

const RAW_CONNECTORS: readonly ConnectorCatalogEntry[] = [
  SIMULATED_EXAMPLE_CONNECTOR,
  BNPL_CORE_CONNECTOR,
  JIRA_CONNECTOR,
  GITHUB_CONNECTOR,
  POLYGON_CONNECTOR,
  NEWSAPI_CONNECTOR,
  NOTION_CONNECTOR,
  LINEAR_CONNECTOR,
  AIRTABLE_CONNECTOR,
  STRIPE_CONNECTOR,
  TWILIO_CONNECTOR,
  BRAVE_CONNECTOR,
  FIRECRAWL_CONNECTOR,
  RESEND_CONNECTOR,
  WIKIPEDIA_CONNECTOR,
  ARXIV_CONNECTOR,
  PUBMED_CONNECTOR,
  SEMANTIC_SCHOLAR_CONNECTOR,
  WORLD_BANK_CONNECTOR,
  FRED_CONNECTOR,
  OPENWEATHER_CONNECTOR,
  SLACK_CONNECTOR,
  VERCEL_CONNECTOR,
  SENTRY_CONNECTOR,
  CLOUDFLARE_CONNECTOR,
  GOOGLE_SHEETS_CONNECTOR,
  GMAIL_CONNECTOR,
  GOOGLE_CALENDAR_CONNECTOR,
  ETORO_MARKET_DATA_CONNECTOR,
  ETORO_ACCOUNT_CONNECTOR,
  ETORO_TRADING_CONNECTOR,
];

/**
 * Ordered catalog of curated connectors, validated through
 * `ConnectorCatalogEntrySchema` (and its embedded `ApiDefinitionSchema`
 * superRefine) at module load. Visible entries appear in the connector shop;
 * entries with `hidden: true` are test fixtures only.
 */
export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = Object.freeze(
  RAW_CONNECTORS.map((entry) => {
    const result = ConnectorCatalogEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `Invalid connector "${entry.catalogId}" in catalog: ${result.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return result.data;
  }),
);

const CATALOG_BY_ID: Readonly<Record<string, ConnectorCatalogEntry>> = Object.freeze(
  CONNECTOR_CATALOG.reduce<Record<string, ConnectorCatalogEntry>>((acc, entry) => {
    acc[entry.catalogId] = entry;
    return acc;
  }, {}),
);

/** Fetch a connector catalog entry by id. Returns `null` for unknown ids. */
export function getConnectorCatalogEntry(catalogId: string): ConnectorCatalogEntry | null {
  return CATALOG_BY_ID[catalogId] ?? null;
}

/** List connector catalog entries. Excludes hidden entries by default. */
export function listConnectorCatalog(opts?: {
  includeHidden?: boolean;
}): readonly ConnectorCatalogEntry[] {
  if (opts?.includeHidden) return CONNECTOR_CATALOG;
  return CONNECTOR_CATALOG.filter((e) => !e.hidden);
}
