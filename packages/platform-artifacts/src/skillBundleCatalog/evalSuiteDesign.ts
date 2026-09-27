import type { SkillBundleId, SkillBundleInput } from '@aflow/schemas';

/**
 * The bundle ships one skill and wires nothing. Its inputs — a skill and a
 * simulation — already exist in the space before the suite is worth drafting,
 * and an API binding here would name a world the target skill does not call.
 */
export const EVAL_SUITE_DESIGN: SkillBundleInput = {
  bundleId: 'eval-authoring' as SkillBundleId,
  version: 16,
  name: 'Eval Suite Design',
  tagline: 'Scaffold the golden eval suite for a skill, grounded in its simulated world.',
  description: `Installs the **Eval Suite Design** skill — point it at a skill and the simulation it runs against, and it drafts the cases that would catch that skill regressing.

**What it does**: reads the skill's contract and the simulation's collections, rule profiles and world effects, then designs a stratified set of cases — scenarios sampled in both directions, weighted toward the situations where the wrong move is plausible — and proposes them as one staged change.

**What it deliberately does not do**: run evaluations, read scores, or land a case on its own. Cases arrive only when an operator ratifies the proposal, and ratification re-runs the authoring gate: a case whose checks pass no matter what the skill does is refused there, not accepted and trusted.

**Where it helps most**: the first suite. Deciding which situations deserve a case, what to call them, and what each one actually requires of the skill are the judgements that are hardest without deep platform context — and the ones an empty dataset gives no help with. The draft is a starting point to edit, not a verdict.

**After install**:
1. Make sure the target skill has a simulation configured for the integrations it calls.
2. Ask for a suite — "draft eval cases for <skill>" — naming the skill and the simulation.
3. Review the proposal in the Action Center: ratify the cases that hold up, reject the rest, and re-run with a narrower focus for the strata that came back thin.`,
  tags: ['evals', 'testing', 'simulation', 'quality', 'developer-tools'],
  skillCatalogIds: ['eval-suite-design'],
  prerequisiteBundleIds: [],
  apiDefinitions: [],
  apiBindingTemplates: [],
};
