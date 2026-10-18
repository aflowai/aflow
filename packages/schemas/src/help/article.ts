/**
 * Help articles — what the platform says about itself (Plan 324).
 *
 * Articles are code-owned: the catalog lives in `@aflow/platform-artifacts`
 * and every reader (the help page, the Helmsman's `catalog.help.*`, links from
 * the screens) reads that one source. `anchors` names what an article
 * describes, so a contract test can fail when the thing described is gone.
 */
import { z } from 'zod';
import { EditionIdSchema } from '../edition/descriptor.js';

export const HelpArticleIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A help article id is a kebab-case slug');
export type HelpArticleId = z.infer<typeof HelpArticleIdSchema>;

export const HelpThemeSchema = z.enum([
  'getting-started',
  'models',
  'privacy',
  'concepts',
  'skills',
  'approvals',
  'integrations',
  'this-computer',
  'automation',
  'teams',
  'troubleshooting',
]);
export type HelpTheme = z.infer<typeof HelpThemeSchema>;

export const HelpArticleAnchorsSchema = z.object({
  routes: z
    .array(z.string().min(1))
    .default([])
    .describe('Web routes the article explains, as the route manifest names them'),
  operations: z.array(z.string().min(1)).default([]).describe('Operation ids the article explains'),
});
export type HelpArticleAnchors = z.infer<typeof HelpArticleAnchorsSchema>;

export const HelpArticleSchema = z.object({
  id: HelpArticleIdSchema,
  theme: HelpThemeSchema,
  question: z.string().min(1).max(500).describe('The question as an operator would ask it'),
  summary: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      'The answer in one plain-text paragraph — enough to answer most askings without the body',
    ),
  body: z.string().min(1).describe('The full answer, markdown'),
  editions: z.array(EditionIdSchema).min(1).describe('The editions this answer is true in'),
  anchors: HelpArticleAnchorsSchema.default({}),
  related: z.array(HelpArticleIdSchema).default([]),
  keywords: z
    .array(z.string().min(1))
    .default([])
    .describe('Search terms the question and summary do not already contain'),
});
export type HelpArticle = z.infer<typeof HelpArticleSchema>;
export type HelpArticleInput = z.input<typeof HelpArticleSchema>;

export const HelpArticleSummarySchema = HelpArticleSchema.pick({
  id: true,
  theme: true,
  question: true,
  summary: true,
});
export type HelpArticleSummary = z.infer<typeof HelpArticleSummarySchema>;
