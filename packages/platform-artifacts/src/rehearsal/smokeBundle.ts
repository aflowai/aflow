import type { BundleRehearsalResult } from '@aflow/schemas';
import { computeStoreCatalogHashes } from '../storeCatalog/index.js';
import {
  MockRehearsalClient,
  type BundleSmokeFixtures,
  type SkillTaskRunner,
} from './mockRehearsalClient.js';
import { getBundleRehearsalPlan } from './plans.js';
import { rehearseInstalledBundle } from './rehearseBundle.js';
import { getBundleSmokeFixtures } from './smokeFixtures/index.js';

/**
 * The smoke run of a Store bundle: its rehearsal plan, run end to end by the
 * go-live rehearsal engine against `MockRehearsalClient`. It proves the
 * artifact runs all the way before it ships. `yarn store:smoke --record`
 * adds a result to storeSmokes.json, and a pass there satisfies the Plan 346
 * gate. The go-live rehearsal in a real space is the optional stronger check.
 */

export const SMOKE_COMMAND = 'yarn store:smoke';

/** The space id a smoke result names. No space exists behind it. */
export const SMOKE_SPACE_ID = '00000000-0000-0000-0000-000000000000';

/** Smoke `catalogId` with its own fixtures, or with `fixtures` where a test names others. */
export async function smokeBundle<Failure>(
  catalogId: string,
  runner: SkillTaskRunner<Failure>,
  fixtures: BundleSmokeFixtures | null = getBundleSmokeFixtures(catalogId),
): Promise<BundleRehearsalResult> {
  const plan = getBundleRehearsalPlan(catalogId);
  if (plan === null) throw new Error(`${catalogId} has no rehearsal plan.`);
  if (fixtures === null) {
    throw new Error(
      `${catalogId} has no smoke fixtures. Add them to packages/platform-artifacts/src/rehearsal/smokeFixtures/.`,
    );
  }
  const published = computeStoreCatalogHashes()[catalogId];
  if (published === undefined) throw new Error(`${catalogId} is no Store listing.`);
  return rehearseInstalledBundle({
    plan,
    target: { catalogId, ...published },
    spaceId: SMOKE_SPACE_ID,
    client: new MockRehearsalClient({ fixtures, published, runner }),
    parameters: { ...fixtures.parameters },
    pollMs: 0,
  });
}

/** One line per step, then the verdict: the failing step on a failure, the first skip on a skip. */
export function smokeReport(result: BundleRehearsalResult): string[] {
  const lines = [
    `Smoke run of ${result.catalogId}: its rehearsal plan against mock integrations, with no space, no credential and no network.`,
    '',
    ...result.steps.map((s) => `${s.outcome.padEnd(7)} ${s.stepId}: ${s.detail}`),
  ];
  for (const skill of result.uncovered) {
    lines.push(`not run ${skill.skillCatalogId}: ${skill.reason}`);
  }
  const verdict =
    result.outcome === 'fail'
      ? `fail at ${result.failingStep?.stepId ?? '?'}`
      : result.outcome === 'skipped'
        ? `skipped: ${result.skipReason ?? ''}`
        : result.outcome;
  lines.push('', `${result.catalogId} version ${String(result.version)} smoke: ${verdict}`);
  return lines;
}
