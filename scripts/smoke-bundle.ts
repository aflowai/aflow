/**
 * The smoke run of a Store bundle: its rehearsal plan, run end to end against
 * mock integrations, before it ships. It needs no space, no API key, no
 * network and no running stack. Each run executes the skill's own task graph
 * in memory, and fixtures in
 * packages/platform-artifacts/src/rehearsal/smokeFixtures/ answer every
 * integration and agent task. It prints each step's pass, fail or skip with
 * its reason, and records nothing.
 *
 * Run:
 *   yarn store:smoke <catalogId>
 *
 * The exit code is 0 on a pass, 1 when a step failed or was skipped, and 2
 * when the bundle has no plan or no fixtures. The go-live rehearsal in a real
 * space is `yarn store:rehearse`, and this run does not replace it.
 */
import { failWith, runSkillTasks } from '@aflow/cybernetic-runtime';
import { listSmokedBundles, smokeBundle, smokeReport } from '@aflow/platform-artifacts';

const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
if (
  !nodeOptions.includes('ts-source') &&
  !process.execArgv.some((arg) => arg.includes('ts-source'))
) {
  console.error(
    'Refusing to smoke prebuilt dist output, which may not be this revision. Re-run as:\n' +
      "  NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/smoke-bundle.ts <catalogId>",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [catalogId] = process.argv.slice(2);
  if (catalogId === undefined) {
    console.error(
      `Name the bundle to smoke: yarn store:smoke <catalogId>. Bundles with fixtures: ${listSmokedBundles().join(', ')}.`,
    );
    process.exit(2);
  }
  let result;
  try {
    result = await smokeBundle(catalogId, { runSkillTasks, failWith });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  for (const line of smokeReport(result)) console.log(line);
  process.exit(result.outcome === 'pass' ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
