import { describe, expect, it } from 'vitest';
import { validateCampaignConfig } from '@aflow/cybernetic-runtime';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { BUNDLE_REHEARSAL_PLANS } from '../rehearsal/plans.js';

/**
 * A rehearsal plan is held to the bundle it rehearses, so a plan cannot pass
 * by naming a task, an input or a skill the bundle does not have.
 */
describe.each(BUNDLE_REHEARSAL_PLANS.map((plan) => [plan.catalogId, plan] as const))(
  'the rehearsal plan of %s',
  (catalogId, plan) => {
    const bundle = getSkillBundleEntry(catalogId)!;

    it('rehearses a bundle in the catalog', () => {
      expect(bundle).not.toBeNull();
    });

    it('runs or names every skill the bundle carries, and nothing else', () => {
      const run = new Set(plan.steps.flatMap((s) => (s.kind === 'run' ? [s.skillCatalogId] : [])));
      const uncovered = plan.uncovered.map((u) => u.skillCatalogId);
      expect(uncovered.filter((id) => run.has(id))).toEqual([]);
      expect([...new Set([...run, ...uncovered])].sort()).toEqual(
        [...bundle.skillCatalogIds].sort(),
      );
    });

    for (const step of plan.steps) {
      if (step.kind === 'campaign_start') {
        it(`${step.stepId}: its campaign passes the skill's campaign contract`, () => {
          const skill = bundleSkills(bundle.skillCatalogIds).find(
            (s) => s.bundle.workflow.slug === step.slug,
          );
          const contract = skill?.bundle.manifest.campaign;
          expect(contract).toBeDefined();
          const validated = validateCampaignConfig(contract!, step.config);
          expect(validated.ok ? [] : validated.issues).toEqual([]);
        });
        continue;
      }
      it(`${step.stepId}: names the skill's slug, its run inputs and its tasks`, () => {
        const skill = getSkillCatalogEntry(step.skillCatalogId)!;
        const wf = skill.bundle.workflow;
        expect(wf.slug).toBe(step.slug);
        const declared = new Set((wf.runInputs ?? []).map((r) => r.id));
        expect(Object.keys(step.inputs).filter((k) => !declared.has(k))).toEqual([]);
        const required = (wf.runInputs ?? []).filter((r) => r.required).map((r) => r.id);
        expect(required.filter((id) => !(id in step.inputs))).toEqual([]);
        const tasks = new Map(wf.tasks.map((t) => [t.taskId, t]));
        expect(step.requiredTasks.filter((id) => !tasks.has(id))).toEqual([]);
        // Only an optional task may fail by design: a required one fails the run.
        expect(
          step.toleratedFailures.filter((t) => tasks.get(t.taskId)?.optional !== true),
        ).toEqual([]);
      });
    }
  },
);

function bundleSkills(ids: readonly string[]) {
  return ids.map((id) => getSkillCatalogEntry(id)!);
}
