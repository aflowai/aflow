import { BACKGROUND_SCAN_EXCEPTIONS, BACKGROUND_TASKS } from './registry.js';
import type { BackgroundTaskDefinition } from './backgroundTask.js';

const GENERATED_HEADER =
  '<!-- GENERATED FILE — edit packages/schemas/src/background/registry.ts and run `yarn background-work:docs`. -->';

function cadence(task: BackgroundTaskDefinition): string {
  if (task.baseCadenceMs === undefined) return 'event-driven';
  const ms = task.baseCadenceMs;
  if (ms >= 60_000) return `${String(Math.round(ms / 60_000))}m`;
  if (ms >= 1000) return `${String(ms / 1000)}s`;
  return `${String(ms)}ms`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function summaryTable(tasks: readonly BackgroundTaskDefinition[]): string {
  const header = [
    '| Task | Service | Criticality | Trigger | Scope | Cadence | Idle ops/min | Disable |',
    '| ---- | ------- | ----------- | ------- | ----- | ------- | -----------: | ------- |',
  ];
  const rows = tasks.map(
    (task) =>
      `| \`${task.id}\` | ${task.service} | ${task.criticality} | ${task.trigger} | ${task.scope} | ${cadence(task)} | ${String(task.idleOperationBudgetPerMinute)} | ${task.disablePolicy} |`,
  );
  return [...header, ...rows].join('\n');
}

function taskSection(task: BackgroundTaskDefinition): string {
  const lines = [
    `### \`${task.id}\``,
    '',
    `**Purpose.** ${task.purpose}`,
    '',
    `**Invariant.** ${task.invariant}`,
    '',
    `**Recovery.** ${task.recovery}`,
    '',
    '| Field | Value |',
    '| ----- | ----- |',
    `| Service | ${task.service} |`,
    `| Owner domain | ${task.ownerDomain} |`,
    `| Criticality | ${task.criticality} |`,
    `| Trigger | ${task.trigger} |`,
    `| Execution scope | ${task.scope} |`,
    `| Substrate | ${task.substrate} |`,
    `| Base cadence | ${cadence(task)} |`,
    `| Max batch | ${String(task.maxBatch)} |`,
    `| Max cycle | ${String(task.maxCycleMs)} ms |`,
    `| Idle datastore ops/min | ${String(task.idleOperationBudgetPerMinute)} |`,
    `| Hot-path producer budget | ${String(task.hotPathProducerBudget.maxAdditionalNetworkRoundTrips)} added RTT — ${escapeCell(task.hotPathProducerBudget.description)} |`,
    `| Feature gate | ${task.featureGate ?? '—'} |`,
    `| Disable policy | ${task.disablePolicy} |`,
    `| Residual poll | ${task.residualPollMs !== undefined ? `${String(task.residualPollMs)} ms` : '—'} |`,
    `| Source | ${task.sites.map((site) => `\`${site.path}\``).join('<br>')} |`,
  ];
  if (task.note !== undefined) {
    lines.push('', `> ${task.note}`);
  }
  return lines.join('\n');
}

/**
 * Deliberately absent from `background/index.ts`: this is a documentation
 * generator with two callers — the generate script and the freshness test — and
 * every workspace importing `@aflow/schemas` would otherwise carry it.
 *
 * Render the operator-facing background-work catalog. The generated file is
 * committed and a contract test fails when it drifts from the registry, so the
 * registry stays the only place a task is declared.
 */
/**
 * Which tasks this checkout documents.
 *
 * The registry is core and survives an edition cut; a task it declares may be
 * implemented by a workspace the cut removes. Documenting that one describes
 * work the artifact cannot do, and the catalog is generated and byte-compared,
 * so the claim would be committed and then asserted.
 *
 * Asked of the tree rather than of a tier field on the entry: the sites already
 * say where the task lives, and a second statement of the same fact is one that
 * can disagree with the first.
 */
export function renderBackgroundWorkCatalog(
  carries: (path: string) => boolean = () => true,
): string {
  const tasks = [...BACKGROUND_TASKS]
    .filter((task) => task.sites.length === 0 || task.sites.some((site) => carries(site.path)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const services = [...new Set(tasks.map((task) => task.service))].sort();

  const residualPolls = tasks.filter((task) => task.residualPollMs !== undefined);

  // Budgets are grouped, never summed into one number: per-instance,
  // per-shard-owner, and per-subscription costs multiply by different things,
  // and adding them produces a figure that describes no real deployment.
  const scopes: ReadonlyArray<BackgroundTaskDefinition['scope']> = [
    'per_instance',
    'singleton',
    'shard_owner',
    'active_subscription',
  ];
  const budgetByScope = scopes
    .map((scope) => ({
      scope,
      total: tasks
        .filter((task) => task.scope === scope)
        .reduce((sum, task) => sum + task.idleOperationBudgetPerMinute, 0),
    }))
    .filter((row) => row.total > 0);

  const SCOPE_MULTIPLIER: Record<BackgroundTaskDefinition['scope'], string> = {
    per_instance: 'per live process',
    singleton: 'once per fleet',
    shard_owner: 'per shard-owning orchestrator',
    active_subscription: 'per active subscription',
  };

  const parts: string[] = [
    GENERATED_HEADER,
    '',
    '# Background work catalog',
    '',
    'Every stateful background task in production, generated from the checked registry in',
    '`packages/schemas/src/background/registry.ts`.',
    '',
    'Production background discovery must be event- or candidate-driven. A task may not find its',
    'work by scanning the Redis keyspace, reading a whole dirty set, or enumerating tenant schemas;',
    'idle cost may not grow with logical shards, tenants, stored keys, or connected subscribers.',
    '',
    `**${String(tasks.length)} registered tasks** across ${String(services.length)} services.`,
    `${String(residualPolls.length)} task(s) still carry a residual poll — a periodic datastore read that`,
    'exists only because an event or candidate path is incomplete.',
    '',
    '## Declared idle budget',
    '',
    'Datastore operations per minute with zero due work, grouped by what each scope multiplies by.',
    '',
    '| Execution scope | Multiplies by | Operations/minute |',
    '| --------------- | ------------- | ----------------: |',
    ...budgetByScope.map(
      (row) =>
        `| ${row.scope} | ${SCOPE_MULTIPLIER[row.scope]} | ${String(Math.round(row.total))} |`,
    ),
    '',
    '## Summary',
    '',
    summaryTable(tasks),
    '',
    '## Tasks',
    '',
    tasks.map(taskSection).join('\n\n'),
    '',
    '## Keyspace-discovery exceptions',
    '',
    'Wildcard discovery that survives outside the candidate model. Each entry is operator-,',
    'migration-, or anomaly-triggered and never a recurring scheduler.',
    '',
    '| Site | Mechanism | Owner | Reason | Bound |',
    '| ---- | --------- | ----- | ------ | ----- |',
    ...BACKGROUND_SCAN_EXCEPTIONS.map(
      (exception) =>
        `| \`${exception.site}\` | ${exception.discovery.map((claim) => (claim.count > 1 ? `${claim.rule} ×${String(claim.count)}` : claim.rule)).join(', ')} | ${exception.owner} | ${escapeCell(exception.reason)} | ${escapeCell(exception.bound)} |`,
    ),
    '',
  ];

  return parts.join('\n');
}
