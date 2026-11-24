/**
 * The go-live rehearsal of a Store bundle (Plan 346): runs the bundle's
 * operating flow in a space that installed it, through the running stack's
 * API, and records the result in
 * packages/platform-artifacts/src/storeRehearsals.json. A publication of the
 * bundle reads that record: the store hash snapshot is re-stamped for a
 * rehearsed bundle only on a passing rehearsal of the version and content
 * hash it publishes.
 *
 * The rehearsal places no broker order. It holds every write the space makes
 * for approval and refuses each one, and it restores the space's write policy
 * and ends its campaign at the end. Use a space kept for rehearsals: its
 * ledger is archived when the rehearsal campaign starts.
 *
 * Run:
 *   AFLOW_API_KEY=<key> NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/rehearse-bundle.ts \
 *     <catalogId> --space <spaceId> [--folder-binding <bindingId>] [--update] [--api <url>]
 *
 * `--update` applies the Store update first when the space holds an older
 * version, so a Store update and its rehearsal are one command. The exit code
 * is 0 on a pass and 1 on a failure or a skip.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  computeStoreCatalogHashes,
  getBundleRehearsalPlan,
  HttpRehearsalClient,
  rehearseInstalledBundle,
  type RehearsalClient,
} from '@aflow/platform-artifacts';
import { StoreRehearsalLedgerSchema, type StoreRehearsalLedger } from '@aflow/schemas';

const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
if (
  !nodeOptions.includes('ts-source') &&
  !process.execArgv.some((arg) => arg.includes('ts-source'))
) {
  console.error(
    'Refusing to rehearse from prebuilt dist output, which may not be this revision. Re-run as:\n' +
      "  NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/rehearse-bundle.ts <catalogId> --space <spaceId>",
  );
  process.exit(2);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]) {
  const [catalogId, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const queue = [...rest];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const next = queue[0];
    if (next === undefined || next.startsWith('--')) flags.set(arg.slice(2), true);
    else flags.set(arg.slice(2), queue.shift() ?? true);
  }
  const text = (name: string) => {
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  return {
    catalogId,
    spaceId: text('space'),
    folderBindingId: text('folder-binding'),
    apiUrl: text('api') ?? process.env['AFLOW_API_URL'] ?? 'http://localhost:3000',
    update: flags.get('update') === true,
  };
}

/** The exchange-local date now: the trading day a desk run is asked for. */
function exchangeDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A client for a rehearsal that cannot reach the platform, which says why on its first call. */
function unreachableClient(reason: string): RehearsalClient {
  const refuse = () => Promise.reject(new Error(reason));
  return {
    readInstall: refuse,
    applyUpdate: refuse,
    readWritePolicy: refuse,
    writeWritePolicy: refuse,
    startCampaign: refuse,
    endCampaign: refuse,
    startRun: refuse,
    readRun: refuse,
    cancelRun: refuse,
    listHeldWrites: refuse,
    refuseWrite: refuse,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.catalogId === undefined) {
    console.error(
      'Name the bundle to rehearse: scripts/rehearse-bundle.ts <catalogId> --space <spaceId>',
    );
    process.exit(2);
  }
  const plan = getBundleRehearsalPlan(args.catalogId);
  if (plan === null) {
    console.error(
      `${args.catalogId} has no rehearsal plan. Add one to packages/platform-artifacts/src/rehearsal/plans.ts.`,
    );
    process.exit(2);
  }
  const published = computeStoreCatalogHashes()[args.catalogId];
  if (published === undefined) {
    console.error(`${args.catalogId} is no Store listing.`);
    process.exit(2);
  }
  const spaceId = args.spaceId !== undefined && UUID.test(args.spaceId) ? args.spaceId : null;
  if (args.spaceId !== undefined && spaceId === null) {
    console.error(`--space ${args.spaceId} is not a space id.`);
    process.exit(2);
  }
  const apiUrl = args.apiUrl.replace(/\/$/, '');
  const apiKey = process.env['AFLOW_API_KEY'] ?? '';

  /** Why the platform cannot be rehearsed against at all, each cause found before any step. */
  async function unavailableCauses(): Promise<string[]> {
    const causes: string[] = [];
    try {
      const health = await fetch(`${apiUrl}/v1/health`);
      if (!health.ok)
        causes.push(`the API at ${apiUrl} answered ${String(health.status)} on /v1/health`);
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      causes.push(
        `the API at ${apiUrl} did not answer: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}`,
      );
    }
    if (apiKey === '')
      causes.push('no API key: set AFLOW_API_KEY to a key of a member who administers the space');
    if (spaceId === null)
      causes.push('no space named: name the space that installed the bundle with --space');
    return causes;
  }

  const unavailable = await unavailableCauses();
  const client =
    unavailable.length > 0 || spaceId === null
      ? unreachableClient(unavailable.join('. '))
      : new HttpRehearsalClient({
          apiUrl,
          apiKey,
          tenantId: process.env['AFLOW_TENANT_ID'],
          spaceId,
        });

  const result = await rehearseInstalledBundle({
    plan,
    target: { catalogId: args.catalogId, ...published },
    spaceId,
    client,
    parameters: {
      tradingDay: exchangeDate(new Date()),
      ...(args.folderBindingId !== undefined ? { folderBindingId: args.folderBindingId } : {}),
    },
    update: args.update,
    unavailable,
  });

  const ledgerPath = fileURLToPath(
    new URL('../packages/platform-artifacts/src/storeRehearsals.json', import.meta.url),
  );
  const ledger: StoreRehearsalLedger = existsSync(ledgerPath)
    ? StoreRehearsalLedgerSchema.parse(JSON.parse(readFileSync(ledgerPath, 'utf8')))
    : {};
  ledger[args.catalogId] = result;
  const sorted = Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(ledgerPath, `${JSON.stringify(sorted, null, 2)}\n`);

  for (const step of result.steps) {
    console.log(`${step.outcome.padEnd(7)} ${step.stepId}: ${step.detail}`);
  }
  for (const skill of result.uncovered) {
    console.log(`not run ${skill.skillCatalogId}: ${skill.reason}`);
  }
  const verdict =
    result.outcome === 'pass'
      ? 'pass'
      : result.outcome === 'fail'
        ? `fail at ${result.failingStep?.stepId ?? '?'}`
        : `skipped: ${result.skipReason ?? ''}`;
  console.log(
    `\n${args.catalogId} version ${String(result.version)}: ${verdict}\nRecorded in ${ledgerPath}`,
  );
  process.exit(result.outcome === 'pass' ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
