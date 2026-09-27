import type { PlatformSkillBundleEntry, PlatformWorkflowDef } from './types.js';

export function buildAuthoringPlatformSkillBundles(deps: {
  epoch: string;
  composeWorkflow: PlatformWorkflowDef;
  composeEvalSuite: NonNullable<PlatformSkillBundleEntry['evalSuite']>;
  bindWorkflow: PlatformWorkflowDef;
  bindEvalSuite: NonNullable<PlatformSkillBundleEntry['evalSuite']>;
}): PlatformSkillBundleEntry[] {
  return [
    {
      skillId: 'compose-skill',
      manifest: {
        schemaVersion: 2,
        skillId: 'compose-skill',
        name: 'Compose Skill',
        goal: {
          type: 'subjective',
          rubric: ['Create a complete, validated skill bundle from a goal description.'],
        },
        mode: 'process',
        origin: 'platform',
        workflowSlug: 'compose-skill',
        evalSuiteRef: '/evals/compose-skill/suite.json',
        requiredCapabilities: [],
        createdAt: deps.epoch,
        updatedAt: deps.epoch,
      },
      workflow: deps.composeWorkflow,
      evalSuite: deps.composeEvalSuite,
    },
    {
      skillId: 'bind-capability',
      manifest: {
        schemaVersion: 2,
        skillId: 'bind-capability',
        name: 'Bind Capability',
        goal: {
          type: 'subjective',
          rubric: ['Produce a validated API definition proposal for operator ratification.'],
        },
        mode: 'process',
        origin: 'platform',
        workflowSlug: 'bind-capability',
        evalSuiteRef: '/evals/bind-capability/suite.json',
        requiredCapabilities: [],
        createdAt: deps.epoch,
        updatedAt: deps.epoch,
      },
      workflow: deps.bindWorkflow,
      evalSuite: deps.bindEvalSuite,
    },
  ];
}
