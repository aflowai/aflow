import { describe, it, expect } from 'vitest';
import { ALL_PLATFORM_WORKFLOWS } from '../skillBundles.js';
import { SKILL_CATALOG } from '../skillCatalog.js';

interface MaybeWorkflow {
  slug: string;
  runtime?: Record<string, unknown>;
  tasks?: Array<Record<string, unknown>>;
}

function collectAllPlatformWorkflows(): MaybeWorkflow[] {
  const wfs: MaybeWorkflow[] = [];
  for (const wf of ALL_PLATFORM_WORKFLOWS) {
    wfs.push(wf as unknown as MaybeWorkflow);
  }
  for (const entry of SKILL_CATALOG) {
    const bundle = (entry as unknown as { bundle?: { workflow?: MaybeWorkflow } }).bundle;
    if (bundle?.workflow) {
      wfs.push(bundle.workflow);
    }
  }
  return wfs;
}

describe('Plan 123 cleanup — priorResults / runtime.typedInputs sentinel', () => {
  const allWorkflows = collectAllPlatformWorkflows();

  it('platform workflow set is non-empty (sanity check)', () => {
    expect(allWorkflows.length).toBeGreaterThan(0);
  });

  it('no platform workflow declares runtime.typedInputs', () => {
    for (const wf of allWorkflows) {
      expect(wf.runtime, `workflow ${wf.slug} should have no runtime block`).toBeUndefined();
    }
  });

  it('no platform workflow task declares context.priorResults', () => {
    for (const wf of allWorkflows) {
      for (const task of wf.tasks ?? []) {
        const ctx = task['context'] as Record<string, unknown> | undefined;
        if (ctx) {
          expect(
            ctx['priorResults'],
            `workflow ${wf.slug} task ${String(task['taskId'])} should not declare context.priorResults`,
          ).toBeUndefined();
        }
      }
    }
  });

  it('every dependent agent task has at least one inputBinding (typed channel must have something to deliver)', () => {
    for (const wf of allWorkflows) {
      const tasks = wf.tasks ?? [];
      for (const task of tasks) {
        if (task['type'] !== 'agent') continue;
        const dependsOn = (task['dependsOn'] as string[] | undefined) ?? [];
        if (dependsOn.length === 0) continue;
        const bindings = task['inputBindings'] as Record<string, unknown> | undefined;
        const bindingCount = bindings ? Object.keys(bindings).length : 0;
        expect(
          bindingCount,
          `workflow ${wf.slug} agent task ${String(task['taskId'])} depends on [${dependsOn.join(', ')}] but has no inputBindings — it would run blind under the typed-only channel`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
