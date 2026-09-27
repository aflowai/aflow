import { describe, expect, it } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { SKILL_CATALOG } from '../skillCatalog.js';

/**
 * A run input is only real if a caller can pass it. Start-time validation
 * checks `inputs` against the ENTRY task's binding surface, so a slot declared
 * in `runInputs` but absent there is refused with UNKNOWN_BINDAS — and the
 * skill reports a valid contract while being un-startable.
 */
describe('every catalog skill can be passed the run inputs it declares', () => {
  for (const entry of SKILL_CATALOG) {
    const wf = entry.bundle.workflow;
    if (!wf.runInputs?.length) continue;

    it(`${wf.slug} declares its run inputs on its entry task`, () => {
      const { validity } = materializeAndValidateSkillConfig({
        tasks: wf.tasks,
        stateVariables: wf.stateVariables,
        output: wf.output,
        runInputs: wf.runInputs,
      });
      const unreachable = [...validity.diagnostics, ...validity.advisories]
        .filter((d) => d.code === 'run_input_unreachable')
        .map((d) => d.detail);
      expect(unreachable).toEqual([]);
    });
  }
});
