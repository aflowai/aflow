import { and, eq, inArray } from 'drizzle-orm';
import {
  type Database,
  apiBindings,
  apiCredentials,
  createTenantContext,
  decryptCredentialAsync,
  withTenantSchema,
} from '@aflow/database';
import {
  AuthProfileSchema,
  registerCampaignStartCheck,
  type CampaignStartCheckContext,
  type CampaignStartCheckResult,
  type TenantId,
} from '@aflow/schemas';
import {
  REGIME_BARS_FEED,
  REGIME_BARS_LOOKBACK_MS,
  universeCoverageGaps,
  universeCoverageRefusal,
} from '@aflow/platform-artifacts';

/**
 * The Daily Trading Cycle's universe check at campaign start. It reads the
 * daily bars of every universe member through the space's market-data
 * binding, as read-universe-bars reads them each cycle, and refuses a
 * universe with a member the breadth cannot hold. The refs are spelled here,
 * not read from the skill at load, because suites that mock
 * `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_UNIVERSE_COVERAGE_CHECK_REF = 'trading.universe-coverage' as const;
export const TRADING_MARKET_DATA_BINDING_ID = 'alpaca-market-data-default' as const;

const MARKET_DATA_ORIGIN = 'https://data.alpaca.markets';
const MARKET_DATA_HOST = 'data.alpaca.markets';
const EXCHANGE_TIME_ZONE = 'America/New_York';
/** Thirty members over the lookback fit one page. A few more pages leave room. */
const MAX_PAGES = 5;
const BARS_PAGE_LIMIT = 10_000;

/** How the check reaches the feed: the binding's credentials, or a simulation with no feed. */
export type MarketDataAccess =
  | { kind: 'live'; authorization: string }
  | { kind: 'simulated' }
  | { kind: 'refused'; message: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UniverseCoverageDeps {
  access: () => Promise<MarketDataAccess>;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

const refused = (message: string): CampaignStartCheckResult => ({ ok: false, message });

/** The exchange-local date of `at`, the session a bar of today would belong to. */
function exchangeDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EXCHANGE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Read every member's daily bars over the lookback and refuse the universe
 * when a member holds fewer than the breadth's sessions. A read that cannot
 * complete refuses too, naming what failed: a campaign the check could not
 * check would open its frozen window on a universe nobody has read.
 */
export async function checkUniverseCoverage(
  universe: readonly string[],
  deps: UniverseCoverageDeps,
): Promise<CampaignStartCheckResult> {
  const access = await deps.access();
  if (access.kind === 'refused') return refused(access.message);
  if (access.kind === 'simulated') return { ok: true };
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = (deps.now ?? (() => new Date()))();
  const start = new Date(now.getTime() - REGIME_BARS_LOOKBACK_MS).toISOString();
  const bars: Record<string, Array<{ t: string }>> = {};
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      symbols: universe.join(','),
      timeframe: '1Day',
      start,
      limit: String(BARS_PAGE_LIMIT),
      feed: REGIME_BARS_FEED,
      adjustment: 'all',
      sort: 'asc',
    });
    if (pageToken !== null) query.set('page_token', pageToken);
    let response: Response;
    try {
      response = await fetchImpl(`${MARKET_DATA_ORIGIN}/v2/stocks/bars?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: access.authorization },
        redirect: 'error',
      });
    } catch (error) {
      return refused(
        `the market-data binding ${TRADING_MARKET_DATA_BINDING_ID} could not be read to check the universe: ${error instanceof Error ? error.message : String(error)}. Start the campaign again once the feed answers.`,
      );
    }
    if (!response.ok) {
      return refused(
        `the market-data binding ${TRADING_MARKET_DATA_BINDING_ID} answered ${String(response.status)} to the universe bars read, so the universe cannot be checked. Check its Alpaca credentials, then start the campaign again.`,
      );
    }
    const body = (await response.json()) as {
      bars?: Record<string, Array<{ t: string }>> | null;
      next_page_token?: string | null;
    };
    for (const [symbol, symbolBars] of Object.entries(body.bars ?? {})) {
      (bars[symbol] ??= []).push(...symbolBars);
    }
    pageToken = body.next_page_token ?? null;
    if (pageToken === null) break;
  }
  if (pageToken !== null) {
    return refused(
      `the universe bars read through ${TRADING_MARKET_DATA_BINDING_ID} ran past ${String(MAX_PAGES)} pages, so the universe cannot be checked. Shorten the universe, then start the campaign again.`,
    );
  }
  const gaps = universeCoverageGaps(universe, bars, exchangeDay(now));
  if (gaps.length === 0) return { ok: true };
  return { ok: false, message: universeCoverageRefusal(gaps), details: { universeGaps: gaps } };
}

/** The space's market-data binding as the API executor reads it, with its basic credentials. */
async function readMarketDataAccess(ctx: CampaignStartCheckContext): Promise<MarketDataAccess> {
  const db = ctx.db as Database;
  const missing = (what: string): MarketDataAccess => ({
    kind: 'refused',
    message: `${what}, so the universe cannot be checked against the feed every cycle reads. Install the trading bundle's bindings and add the Alpaca credentials in Integrations, then start the campaign again.`,
  });
  return withTenantSchema(db, createTenantContext(ctx.tenantId as TenantId), async (tx) => {
    const [binding] = await tx
      .select({
        authJson: apiBindings.authJson,
        egressPolicyJson: apiBindings.egressPolicyJson,
        enabled: apiBindings.enabled,
        fulfillmentMode: apiBindings.fulfillmentMode,
      })
      .from(apiBindings)
      .where(
        and(
          eq(apiBindings.spaceId, ctx.spaceId),
          eq(apiBindings.bindingId, TRADING_MARKET_DATA_BINDING_ID),
        ),
      );
    if (binding?.enabled !== 1) {
      return missing(`the space has no enabled binding ${TRADING_MARKET_DATA_BINDING_ID}`);
    }
    if (binding.fulfillmentMode === 'simulated') return { kind: 'simulated' };
    const egress = binding.egressPolicyJson as { allowedHosts?: unknown };
    const hosts = Array.isArray(egress.allowedHosts) ? (egress.allowedHosts as unknown[]) : [];
    if (hosts.length > 0 && !hosts.includes(MARKET_DATA_HOST)) {
      return missing(
        `the binding ${TRADING_MARKET_DATA_BINDING_ID} does not allow ${MARKET_DATA_HOST}`,
      );
    }
    const auth = AuthProfileSchema.safeParse(binding.authJson);
    const keys =
      auth.success && auth.data.type === 'basic'
        ? [auth.data.usernameCredentialKey, auth.data.passwordCredentialKey]
        : [];
    const [usernameKey, passwordKey] = keys;
    if (usernameKey === undefined || passwordKey === undefined) {
      return missing(`the binding ${TRADING_MARKET_DATA_BINDING_ID} names no basic credentials`);
    }
    const rows = await tx
      .select({
        credentialKey: apiCredentials.credentialKey,
        encryptedValue: apiCredentials.encryptedValue,
      })
      .from(apiCredentials)
      .where(
        and(
          eq(apiCredentials.spaceId, ctx.spaceId),
          inArray(apiCredentials.credentialKey, [usernameKey, passwordKey]),
        ),
      );
    const encrypted = new Map(rows.map((row) => [row.credentialKey, row.encryptedValue]));
    const username = encrypted.get(usernameKey);
    const password = encrypted.get(passwordKey);
    if (username === undefined || password === undefined) {
      return missing(
        `the space stores no Alpaca credentials for ${TRADING_MARKET_DATA_BINDING_ID}`,
      );
    }
    const pair = `${await decryptCredentialAsync(username)}:${await decryptCredentialAsync(password)}`;
    return { kind: 'live', authorization: `Basic ${Buffer.from(pair).toString('base64')}` };
  });
}

async function universeCoverageCheck(
  ctx: CampaignStartCheckContext,
): Promise<CampaignStartCheckResult> {
  const universe = ctx.config['universe'];
  if (!Array.isArray(universe) || !universe.every((s): s is string => typeof s === 'string')) {
    return refused('the campaign config has no universe, so no member can be checked.');
  }
  return checkUniverseCoverage(universe, { access: () => readMarketDataAccess(ctx) });
}

registerCampaignStartCheck(TRADING_UNIVERSE_COVERAGE_CHECK_REF, universeCoverageCheck);
