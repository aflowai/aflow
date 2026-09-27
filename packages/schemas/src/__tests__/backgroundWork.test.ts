/**
 * Contract: production background work is declared, attributed, and bounded.
 *
 * The registry is only a source of truth if the tree cannot drift from it. The
 * scanner walks every production source file for the mechanisms the plan bans
 * as recurring schedulers, and this fails when the occurrences it finds do not
 * match what the registry and its named exceptions declare.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_SCAN_EXCEPTIONS,
  BACKGROUND_TASKS,
  declaredBackgroundDiscovery,
  declaredBackgroundSitePaths,
} from '../background/registry.js';
import { renderBackgroundWorkCatalog } from '../background/renderCatalog.js';
import { cutWasPerformed, ownerOf, survivesCoreCut } from '../edition/ownershipLookup.js';
import {
  parseBackgroundTaskOverrides,
  resolveBackgroundTaskRuntime,
} from '../background/overrides.js';
import {
  countByFileAndRule,
  productionSourceFiles,
  scanBackgroundWork,
} from './backgroundWorkScanner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const CATALOG_PATH = join(REPO_ROOT, 'docs/architecture/background-work.md');
const REGENERATE = 'yarn background-work:docs';

describe('background-work registry', () => {
  it('declares unique, well-formed task ids', () => {
    const ids = BACKGROUND_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BACKGROUND_TASKS.length).toBeGreaterThan(0);
  });

  it('never marks a correctness task as safe to disable', () => {
    const unsafe = BACKGROUND_TASKS.filter(
      (task) => task.criticality === 'correctness' && task.disablePolicy === 'safe',
    ).map((task) => task.id);
    expect(
      unsafe,
      'A correctness task owns a durable invariant; it cannot have a safe off switch.',
    ).toEqual([]);
  });

  it('gives every periodic task a cadence', () => {
    const missing = BACKGROUND_TASKS.filter(
      (task) =>
        (task.trigger === 'candidate' || task.trigger === 'heartbeat') &&
        task.baseCadenceMs === undefined,
    ).map((task) => task.id);
    expect(missing).toEqual([]);
  });

  it('keeps cold audits at their documented floor', () => {
    const tooFast = BACKGROUND_TASKS.filter(
      (task) =>
        task.trigger === 'audit' &&
        task.baseCadenceMs !== undefined &&
        task.baseCadenceMs < 15 * 60_000,
    ).map((task) => task.id);
    expect(
      tooFast,
      'A cold audit runs no faster than every 15 minutes; anything faster is a candidate drain.',
    ).toEqual([]);
  });

  it('never lets a producer add a hot-path round trip', () => {
    const overBudget = BACKGROUND_TASKS.filter(
      (task) => task.hotPathProducerBudget.maxAdditionalNetworkRoundTrips > 0,
    ).map((task) => task.id);
    expect(
      overBudget,
      'Arming a candidate marker extends an existing transaction/Lua/pipeline; it never adds an RTT.',
    ).toEqual([]);
  });
});

describe('background-work overrides', () => {
  it('rejects an override naming an unregistered task', () => {
    const parsed = parseBackgroundTaskOverrides({
      overridesJson: JSON.stringify({ 'orchestrator.not_a_task': { mode: 'disabled' } }),
    });
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.overrides).toEqual({});
  });

  it('refuses to disable a correctness task without break-glass', () => {
    const resolved = resolveBackgroundTaskRuntime('orchestrator.timer_dispatch', {
      overrides: { 'orchestrator.timer_dispatch': { mode: 'disabled' } },
    });
    expect(resolved.mode).toBe('enabled');
    expect(resolved.refusedOverride).toBeDefined();
  });

  it('refuses observe mode on a correctness task without break-glass', () => {
    // `observe` suppresses side effects, so for a sole owner it is a disable by
    // another name and has to clear the same bar.
    const resolved = resolveBackgroundTaskRuntime('orchestrator.timer_dispatch', {
      overrides: { 'orchestrator.timer_dispatch': { mode: 'observe' } },
    });
    expect(resolved.mode).toBe('enabled');
    expect(resolved.refusedOverride).toBeDefined();
  });

  it('allows observe mode on a task that is safe to disable', () => {
    const resolved = resolveBackgroundTaskRuntime('server.space_coach_surface', {
      overrides: { 'server.space_coach_surface': { mode: 'observe' } },
    });
    expect(resolved.mode).toBe('observe');
  });

  it('allows a disable when break-glass names the same task', () => {
    const resolved = resolveBackgroundTaskRuntime('orchestrator.timer_dispatch', {
      overrides: { 'orchestrator.timer_dispatch': { mode: 'disabled' } },
      breakGlassIds: new Set(['orchestrator.timer_dispatch']),
    });
    expect(resolved.mode).toBe('disabled');
    expect(resolved.breakGlassEngaged).toBe(true);
  });

  it('carries the declared execution scope into the runtime config', () => {
    // Scope is what forces a singleton task to hold a lease; dropping it here
    // is how a fleet-wide task quietly starts on every instance.
    expect(resolveBackgroundTaskRuntime('orchestrator.projection').scope).toBe('singleton');
    expect(resolveBackgroundTaskRuntime('orchestrator.timer_dispatch').scope).toBe('shard_owner');
  });

  it('throws when asked to resolve an unregistered task', () => {
    expect(() => resolveBackgroundTaskRuntime('orchestrator.ghost')).toThrow(/not registered/);
  });
});

describe('background-work feature gates', () => {
  const GATED = 'orchestrator.mcp_elicitation_reconcile';
  const gate = BACKGROUND_TASKS.find((task) => task.id === GATED)!.featureGate!;

  it('treats an unset gate as the feature being on', () => {
    // Defaulting closed takes a live task out of service on the first
    // deployment that has never heard of the variable.
    const resolved = resolveBackgroundTaskRuntime(GATED, { env: {} });
    expect(resolved.mode).toBe('enabled');
    expect(resolved.featureGateClosed).toBeUndefined();
  });

  it('takes the task out of service when its gate is explicitly off', () => {
    const resolved = resolveBackgroundTaskRuntime(GATED, { env: { [gate]: 'false' } });
    expect(resolved.mode).toBe('disabled');
    expect(resolved.featureGateClosed).toBe(gate);
  });

  it('reads a gate set to anything else as on', () => {
    expect(resolveBackgroundTaskRuntime(GATED, { env: { [gate]: 'true' } }).mode).toBe('enabled');
    expect(resolveBackgroundTaskRuntime(GATED, { env: { [gate]: '1' } }).mode).toBe('enabled');
  });

  it('refuses a gate that would silence a task with no safe off state', () => {
    // A variable is not a lower bar than the override map: a correctness task
    // still needs break-glass to name it.
    const resolved = resolveBackgroundTaskRuntime('orchestrator.projection', {
      env: { PROJECTION_WORKER_ENABLED: 'off' },
    });
    expect(resolved.mode).toBe('enabled');
    expect(resolved.refusedOverride).toContain('PROJECTION_WORKER_ENABLED');
  });
});

describe('background-work source inventory', () => {
  const findings = scanBackgroundWork(REPO_ROOT);
  const actual = countByFileAndRule(findings);
  const declared = declaredBackgroundDiscovery();

  /**
   * Whether a declared site is one this checkout should still contain.
   *
   * The registry names every background task the platform has, including the
   * ones that only run in the hosted product. A public core cut deletes those
   * workspaces, and a check demanding their files be found would report the cut
   * as a registry error. Uncut — which is this repository — every site counts.
   */
  const cut = cutWasPerformed(productionSourceFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f)));
  const siteIsInThisCheckout = (site: string): boolean => {
    const owner = ownerOf(site);
    return !cut || owner === undefined || survivesCoreCut(owner.owner);
  };

  it('actually walks the tree', () => {
    // A scanner that resolves the wrong root finds nothing and passes every
    // other assertion in this block, so the floor is asserted explicitly.
    expect(productionSourceFiles(REPO_ROOT).length).toBeGreaterThan(500);
    expect(findings.length).toBeGreaterThan(20);
  });

  it('matches every declared occurrence count against the tree', () => {
    const files = [...new Set([...actual.keys(), ...declared.keys()])]
      .filter(siteIsInThisCheckout)
      .sort();
    const mismatches: string[] = [];
    for (const file of files) {
      const found = actual.get(file);
      const claimed = declared.get(file);
      const rules = new Set([...(found?.keys() ?? []), ...(claimed?.keys() ?? [])]);
      for (const rule of rules) {
        const foundCount = found?.get(rule) ?? 0;
        const claimedCount = claimed?.get(rule) ?? 0;
        if (foundCount !== claimedCount) {
          mismatches.push(
            `${file} (${rule}): found ${String(foundCount)}, declared ${String(claimedCount)}`,
          );
        }
      }
    }
    expect(
      mismatches.sort(),
      'Every occurrence of a banned discovery mechanism is owned by exactly one registered task ' +
        'or named exception. Declare it on the owning entry in ' +
        'packages/schemas/src/background/registry.ts — a file already listed for one loop is not ' +
        'a licence for a second.',
    ).toEqual([]);
  });

  it('keeps every declared site pointing at a real file', () => {
    const missing = [...declaredBackgroundSitePaths()]
      .filter(siteIsInThisCheckout)
      .filter((site) => !existsSync(join(REPO_ROOT, site)))
      .sort();
    expect(missing).toEqual([]);
  });

  it('keeps every scan exception attached to an actual finding', () => {
    const stale = BACKGROUND_SCAN_EXCEPTIONS.filter((exception) => !actual.has(exception.site)).map(
      (exception) => exception.site,
    );
    expect(stale.sort(), 'This exception no longer covers any discovery site — delete it.').toEqual(
      [],
    );
  });
});

describe('background-work control-plane consolidation', () => {
  const files = productionSourceFiles(REPO_ROOT);
  const relPath = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');
  const CONTROL_PLANE_DIR = 'packages/schemas/src/background/';

  it('routes every production resolution through the control plane', () => {
    // A direct resolver call silently drops BACKGROUND_TASK_OVERRIDES and
    // break-glass — the exact defect the control plane exists to close.
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relPath(file);
      if (rel.startsWith(CONTROL_PLANE_DIR)) continue;
      const source = readFileSync(file, 'utf8');
      if (/\b(?:resolveBackgroundTaskRuntime|parseBackgroundTaskOverrides)\s*\(/.test(source)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders.sort(),
      'Resolve through backgroundTaskControlPlane() (or the installed plane) instead — the raw ' +
        'resolver never sees operator overrides.',
    ).toEqual([]);
  });

  it('keeps declared feature gates out of direct process.env reads', () => {
    // A bare env check re-creates the silenced-breakglass-task hole: the gate
    // closes with no refusal, no error log, and no signal.
    const gates = BACKGROUND_TASKS.map((task) => task.featureGate).filter(
      (gate): gate is string => gate !== undefined,
    );
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relPath(file);
      const source = readFileSync(file, 'utf8');
      for (const gate of gates) {
        const pattern = new RegExp(
          `process\\.env\\[['"\`]${gate}['"\`]\\]|process\\.env\\.${gate}\\b`,
        );
        if (pattern.test(source)) offenders.push(`${rel} (${gate})`);
      }
    }
    expect(
      offenders.sort(),
      'A registered feature gate is enforced only by the control-plane resolve, where a ' +
        'non-safe task refuses it without break-glass.',
    ).toEqual([]);
  });
});

describe('background-work catalog', () => {
  it('keeps the formerly-bypassed wiring sites gated on their resolved mode', () => {
    // These three ran on bare env checks and literals once, and a refactor that
    // reinstates that reads no gate variable and calls no raw resolver — so
    // neither guard above would notice. The signal asserts these tasks can be
    // disabled; this is what keeps that assertion attached to the code.
    const orchestratorIndex = readFileSync(
      join(REPO_ROOT, 'apps/aflow-orchestrator/src/index.ts'),
      'utf8',
    );
    for (const gate of [
      /projectionRuntime\.mode === 'enabled'/,
      /resolve\('orchestrator\.instance_heartbeat'\)/,
      /timerDispatchEnabled: timerDispatchRuntime\.mode === 'enabled'/,
    ]) {
      expect(orchestratorIndex, String(gate)).toMatch(gate);
    }

    // Completion recording must gate on its OWN task, never on due-time
    // discovery's: discovery's disable is declared safe, and a recording
    // refusal parks terminal projection candidates — a consequence only the
    // recorder's break-glass switch may carry.
    const scheduleEvaluator = readFileSync(
      join(REPO_ROOT, 'apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts'),
      'utf8',
    );
    for (const gate of [
      /RECORDER_TASK_ID = 'orchestrator\.completion_schedule_recorder'/,
      /resolve\(RECORDER_TASK_ID\)/,
      /this\.recorderMode\(\) !== 'enabled'/,
    ]) {
      expect(scheduleEvaluator, String(gate)).toMatch(gate);
    }
  });

  it('matches the generated catalog on disk', () => {
    expect(
      existsSync(CATALOG_PATH),
      `Missing docs/architecture/background-work.md. Run: ${REGENERATE}`,
    ).toBe(true);
    expect(
      readFileSync(CATALOG_PATH, 'utf8'),
      `docs/architecture/background-work.md is stale. Run: ${REGENERATE}`,
    ).toBe(renderBackgroundWorkCatalog((path) => existsSync(join(REPO_ROOT, path))));
  });
});
