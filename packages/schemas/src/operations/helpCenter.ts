import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  HelpGetInputSchema,
  HelpGetOutputSchema,
  HelpSearchInputSchema,
  HelpSearchOutputSchema,
} from '../help/article.js';

const PRODUCT_QUESTIONS_ONLY =
  'A question about the operator’s own work, data, skills or runs — read the space (memory, workflow.manage.get, workflow.run.detail) instead';

export const HelpCenterOperationRegistrations: readonly OperationRegistration[] = [
  {
    stepType: 'catalog',
    group: 'help',
    verb: 'search',
    name: 'Search Help',
    actionLabel: 'Checking the help…',
    semanticDescription:
      'Search Aflow’s own help articles — how the product works, where a screen or setting is, how to set something up, what an edition offers. Returns each match’s question and a short complete answer, the same answers the operator reads on the Help page.',
    tags: ['catalog', 'help', 'search', 'faq', 'documentation'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Look up how Aflow itself works before answering a question about the product.',
      whenToUse: [
        'The operator asks how to do something in Aflow, or where something is',
        'The operator asks what a part of the product means or why it behaves as it does',
      ],
      whenNotToUse: [PRODUCT_QUESTIONS_ONLY],
      pitfalls: [
        'Answer with the article’s navigation path as written; do not invent screens or labels the article does not name',
      ],
      minimalExampleInput: { query: 'how do I add a model provider' },
    },
    inputZod: HelpSearchInputSchema,
    outputZod: HelpSearchOutputSchema,
  },
  {
    stepType: 'catalog',
    group: 'help',
    verb: 'get',
    name: 'Read Help Article',
    actionLabel: 'Reading the help…',
    semanticDescription:
      'Read one Aflow help article in full — the steps, where each control is, and related articles — with the link to its page.',
    tags: ['catalog', 'help', 'faq', 'documentation'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Read the full help answer a search found.',
      whenToUse: ['The summary from catalog.help.search is not enough to answer'],
      whenNotToUse: [PRODUCT_QUESTIONS_ONLY],
      minimalExampleInput: { articleId: 'add-model-provider' },
    },
    inputZod: HelpGetInputSchema,
    outputZod: HelpGetOutputSchema,
  },
];
