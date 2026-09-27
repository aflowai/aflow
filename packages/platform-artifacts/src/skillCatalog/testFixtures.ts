import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';

const TEST_SKILL_A: SkillCatalogEntry = {
  catalogId: '_test-skill-a',
  version: 1,
  name: 'Test Skill A',
  tagline: 'Hidden test fixture A.',
  description: 'Hidden test fixture used by the install-op tests.',
  tags: ['test'],
  hidden: true,
  bundle: {
    workflow: {
      slug: 'test-skill-a',
      name: 'Test Skill A',
      description: 'Hidden test fixture A.',
      goal: 'Test fixture goal.',
      mode: 'process',
      outcomes: [
        {
          id: 'completed',
          name: 'Completed',
          evaluator: { type: 'manual' as const, instruction: 'Fixture completed.' },
        },
      ],
      tasks: [
        {
          taskId: 'do-the-thing',
          name: 'Do The Thing',
          goal: 'Trivial fixture task that writes a marker to memory.',
          type: 'agent' as const,
          context: {
            strategy: 'scoped',
            contextPolicy: 'auto-optimize',
            learnings: 'active',
            capabilities: {
              operations: ['memory.store.put'],
              integrations: [],
            },
          },
        },
      ],
      stateVariables: [],
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'test-skill-a',
      name: 'Test Skill A',
      goal: { type: 'subjective' as const, rubric: ['Test fixture goal.'] },
      mode: 'process' as const,
    },
    evalSuite: {
      goalCriteria: [
        { name: 'marker-written', type: 'contains' as const, inField: 'output', pattern: 'ok' },
      ],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 1.0, task: 0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    activation: {
      triggerPatterns: ['__test_skill_a_trigger__'],
      activationHint: 'Hidden test fixture; never triggered in production.',
      prerequisites: [],
      priority: 50,
    },
    rationale: 'Hidden install-op test fixture.',
  },
};

const TEST_SKILL_B: SkillCatalogEntry = {
  catalogId: '_test-skill-b',
  version: 1,
  name: 'Test Skill B',
  tagline: 'Hidden test fixture B.',
  description: 'Hidden test fixture used by the install-op tests.',
  tags: ['test'],
  hidden: true,
  bundle: {
    workflow: {
      slug: 'test-skill-b',
      name: 'Test Skill B',
      description: 'Hidden test fixture B.',
      goal: 'Test fixture goal.',
      mode: 'process',
      outcomes: [
        {
          id: 'completed',
          name: 'Completed',
          evaluator: { type: 'manual' as const, instruction: 'Fixture completed.' },
        },
      ],
      tasks: [
        {
          taskId: 'do-the-thing',
          name: 'Do The Thing',
          goal: 'Trivial fixture task that writes a marker to memory.',
          type: 'agent' as const,
          context: {
            strategy: 'scoped',
            contextPolicy: 'auto-optimize',
            learnings: 'active',
            capabilities: {
              operations: ['memory.store.put'],
              integrations: [],
            },
          },
        },
      ],
      stateVariables: [],
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'test-skill-b',
      name: 'Test Skill B',
      goal: { type: 'subjective' as const, rubric: ['Test fixture goal.'] },
      mode: 'process' as const,
    },
    evalSuite: {
      goalCriteria: [
        { name: 'marker-written', type: 'contains' as const, inField: 'output', pattern: 'ok' },
      ],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 1.0, task: 0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    rationale: 'Hidden install-op test fixture.',
  },
};

const TEST_SKILL_C: SkillCatalogEntry = {
  catalogId: '_test-skill-c',
  version: 1,
  name: 'Test Skill C',
  tagline: 'Hidden test fixture C.',
  description: 'Hidden test fixture used by the install-op tests.',
  tags: ['test'],
  hidden: true,
  bundle: {
    workflow: {
      slug: 'test-skill-c',
      name: 'Test Skill C',
      description: 'Hidden test fixture C.',
      goal: 'Test fixture goal.',
      mode: 'process',
      outcomes: [
        {
          id: 'completed',
          name: 'Completed',
          evaluator: { type: 'manual' as const, instruction: 'Fixture completed.' },
        },
      ],
      tasks: [
        {
          taskId: 'do-the-thing',
          name: 'Do The Thing',
          goal: 'Trivial fixture task that writes a marker to memory.',
          type: 'agent' as const,
          context: {
            strategy: 'scoped',
            contextPolicy: 'auto-optimize',
            learnings: 'active',
            capabilities: {
              operations: ['memory.store.put'],
              integrations: [],
            },
          },
        },
      ],
      stateVariables: [],
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'test-skill-c',
      name: 'Test Skill C',
      goal: { type: 'subjective' as const, rubric: ['Test fixture goal.'] },
      mode: 'process' as const,
    },
    evalSuite: {
      goalCriteria: [
        { name: 'marker-written', type: 'contains' as const, inField: 'output', pattern: 'ok' },
      ],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 1.0, task: 0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    rationale: 'Hidden install-op test fixture.',
  },
};

// ============================================================================
// _test-api-dependent — hidden test fixture for API dependency flow
// ============================================================================

const TEST_API_DEPENDENT: SkillCatalogEntry = {
  catalogId: 'test-api-dependent',
  version: 2,
  name: 'Test API Dependent',
  tagline: 'Test fixture for API-dependent skill installation.',
  description:
    'Hidden test fixture. Requires a fake test-api binding to exercise needs_binding projection behavior. The task declares a test-api context.tools entry which causes deriveRequiredCapabilities to produce ["test-api"], triggering the activation guard without concrete binding IDs.',
  tags: ['test'],
  hidden: true,
  capabilityHints: [
    {
      apiId: 'test-api',
      description: 'Test API (fixture)',
      requiredEndpoints: ['items.list', 'items.get'],
      authKind: 'bearer',
      setupNote: 'This is a test fixture — no real API exists.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'test-api-dependent',
      name: 'Test API Dependent',
      description: 'Test fixture for API-dependent skill installation.',
      goal: 'Exercise needs_binding activation guard.',
      mode: 'process',
      outcomes: [
        {
          id: 'completed',
          name: 'Completed',
          evaluator: {
            type: 'manual' as const,
            instruction: 'The test fixture completed.',
          },
        },
      ],
      tasks: [
        {
          taskId: 'fetch-items',
          name: 'Fetch Items',
          goal: 'Fetch items from the test API.',
          type: 'agent' as const,
          context: {
            strategy: 'scoped',
            contextPolicy: 'auto-optimize',
            learnings: 'active',
            // Use legacy context.tools for portability — avoids baking in concrete
            // bindingId/capabilityId that would only be valid in one space.
            // deriveRequiredCapabilities extracts 'test-api' as a prefix from these.
            tools: ['test-api.items.list', 'test-api.items.get'],
            capabilities: {
              operations: ['memory.store.put'],
              integrations: [],
            },
          },
        },
      ],
      stateVariables: [],
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'test-api-dependent',
      name: 'Test API Dependent',
      goal: { type: 'subjective' as const, rubric: ['Exercise needs_binding activation guard.'] },
      mode: 'process' as const,
    },
    evalSuite: {
      goalCriteria: [
        {
          name: 'completed',
          type: 'contains' as const,
          inField: 'output',
          pattern: 'items',
        },
      ],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 1.0, task: 0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    rationale: 'Test fixture for API-dependent catalog skills.',
  },
};

export { TEST_SKILL_A, TEST_SKILL_B, TEST_SKILL_C, TEST_API_DEPENDENT };
