import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { SkillSearchInputSchema, SkillSearchOutputSchema } from '../cybernetic/skillDiscovery.js';

export const SkillDiscoveryOperationRegistration: OperationRegistration = {
  stepType: 'catalog',
  group: 'skill',
  verb: 'search',
  name: 'Search Installed Skills',
  actionLabel: 'Finding skills…',
  semanticDescription:
    'Find installed skills by intent, with compact summaries and cursor pagination. Inspect the selected skill with workflow.manage.get view=invocation, then start it with workflow.run.start. Skills run through their own Runners; no tool promotion is needed.',
  tags: ['catalog', 'skill', 'search'],
  idempotency: 'idempotent',
  mutates: false,
  accessMode: 'read',
  usage: {
    whenNotToUse: ['Acquiring a new skill — use store.listing.search'],
    oneLine: 'Search the installed playbook before choosing a skill.',
    whenToUse: [
      'Finding a skill for the operator’s request',
      'Browsing skills beyond the pinned summaries',
    ],
    minimalExampleInput: { query: 'review a pull request' },
  },
  inputZod: SkillSearchInputSchema,
  outputZod: SkillSearchOutputSchema,
};
