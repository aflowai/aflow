/**
 * The smoke run of a Store bundle: its rehearsal plan, run end to end against
 * mock integrations, before it ships. It needs no space, no API key, no
 * network and no running stack. Each run executes the skill's own task graph
 * in memory, and fixtures in
 * packages/platform-artifacts/src/rehearsal/smokeFixtures/ answer every
 * integration and agent task. It prints each step's pass, fail or skip with
 * its reason.
 *
 * Run:
 *   yarn store:smoke <catalogId> [--record]
 *
 * `--record` adds the result to the bundle's records in
 * packages/platform-artifacts/src/storeSmokes.json (Plan 346 D7). From a
 * plan's `gateFromVersion` on, the store hash script re-stamps a new version
 * only on a passing smoke record or go-live rehearsal record of that version
 * and content hash. A pass stays on record when a later smoke of the same
 * version skips or fails. Without `--record` the run records nothing.
 *
 * The exit code is 0 on a pass, 1 when a step failed or was skipped, and 2
 * when the bundle has no plan or no fixtures. The go-live rehearsal in a real
 * space is `yarn store:rehearse`, the optional stronger check.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skillTaskRunner } from '@aflow/cybernetic-runtime';
import {
  listSmokedBundles,
  recordRehearsal,
  smokeBundle,
  smokeReport,
} from '@aflow/platform-artifacts';
import { StoreRehearsalLedgerSchema, type StoreRehearsalLedger } from '@aflow/schemas';

const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
if (
  !nodeOptions.includes('ts-source') &&
  !process.execArgv.some((arg) => arg.includes('ts-source'))
) {
  console.error(
    'Refusing to smoke prebuilt dist output, which may not be this revision. Re-run as:\n' +
      "  NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/smoke-bundle.ts <catalogId> [--record]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const unknownFlags = args.filter((a) => a.startsWith('--') && a !== '--record');
  const [catalogId, ...extra] = args.filter((a) => !a.startsWith('--'));
  if (catalogId === undefined || extra.length > 0 || unknownFlags.length > 0) {
    console.error(
      `Name one bundle to smoke: yarn store:smoke <catalogId> [--record]. Bundles with fixtures: ${listSmokedBundles().join(', ')}.`,
    );
    process.exit(2);
  }
  let result;
  try {
    result = await smokeBundle(catalogId, skillTaskRunner);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  for (const line of smokeReport(result)) console.log(line);
  if (record) {
    const ledgerPath = fileURLToPath(
      new URL('../packages/platform-artifacts/src/storeSmokes.json', import.meta.url),
    );
    const ledger: StoreRehearsalLedger = existsSync(ledgerPath)
      ? StoreRehearsalLedgerSchema.parse(JSON.parse(readFileSync(ledgerPath, 'utf8')))
      : {};
    ledger[catalogId] = recordRehearsal(ledger[catalogId], result);
    const sorted = Object.fromEntries(
      Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(ledgerPath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Recorded in ${ledgerPath}`);
  }
  process.exit(result.outcome === 'pass' ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
