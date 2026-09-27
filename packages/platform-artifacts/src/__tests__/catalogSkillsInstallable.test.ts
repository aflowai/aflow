import { describe, expect, it } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { SKILL_CATALOG } from '../skillCatalog.js';

/**
 * Every catalog skill must pass the validation the INSTALLER runs, not a
 * narrower one. `validateWorkflowGraph` alone misses whole dimensions — an
 * `op_input_incompatible` bind, for instance — so a skill can be green here
 * and refused the moment someone installs it.
 */
describe('every catalog skill passes the validation its install runs', () => {
  for (const entry of SKILL_CATALOG) {
    const wf = entry.bundle.workflow;

    it(`${wf.slug} is installable`, () => {
      const bundle = entry.bundle;
      const { validity } = materializeAndValidateSkillConfig({
        tasks: wf.tasks,
        stateVariables: wf.stateVariables,
        output: wf.output,
        runInputs: wf.runInputs,
        mode: wf.mode,
        bundle: {
          uiOutput: bundle.manifest.uiOutput,
          taskCriteria: bundle.evalSuite?.taskCriteria,
          evalSuite: bundle.evalSuite,
        },
        campaign: {
          contract: bundle.manifest.campaign,
          goal: bundle.manifest.goal,
          outcomes: wf.outcomes,
          goalCriteria: bundle.evalSuite?.goalCriteria,
        },
      });
      const blocking = validity.diagnostics.map((d) => `${d.code}: ${d.detail}`);
      expect(blocking).toEqual([]);
      expect(validity.status).toBe('valid');
    });
  }
});
