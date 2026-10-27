/**
 * A space template — the payload of a Store listing of kind `space` (Plan 330
 * D1). Installing one creates a new space and applies the template to it: each
 * bundle it names goes through the bundle install path, and its directives,
 * agents and api_definitions become the new space's own data.
 */
import { z } from 'zod';
import {
  BundledApiDefinitionSchema,
  BundledSkillStarterAgentSchema,
  PostInstallTaskSchema,
  PostInstallTaskStateSchema,
} from '../cybernetic/skillBundle.js';
import { EntityDirectivesSchema } from '../cybernetic/directives.js';
import { HelpArticleIdSchema } from '../help/article.js';
import { CatalogIdSchema } from './listingCore.js';

/** Every post-install task kind, read off the union so the two cannot drift. */
export const POST_INSTALL_TASK_KINDS: readonly string[] = PostInstallTaskSchema.options.map(
  (option) => option.shape.kind.value,
);

/** Whether each kind is required, as its variant pins it: an item cannot say otherwise. */
const REQUIRED_BY_KIND: ReadonlyMap<string, boolean> = new Map(
  PostInstallTaskSchema.options.map((option) => [
    option.shape.kind.value,
    option.shape.required.value,
  ]),
);

export const SpaceReadinessStateSchema = PostInstallTaskStateSchema;
export type SpaceReadinessState = z.infer<typeof SpaceReadinessStateSchema>;

/**
 * One thing the space needs before it works (Plan 330 D4). Its state is never
 * authored: it is read from live state when the readiness list is asked for.
 * `answeredBy` names the post-install task kind that answers it, and
 * `reading` which of `pair_machine`'s two readings does — both, worst first,
 * where it names neither.
 * The template's items are handed to `generatePostInstallManifest`, so the
 * template's list is read by the function the bundle install reads, not a
 * second one: a stateful task's state is the item's, and a kind listed only
 * while unmet makes the item `needs_setup` while it is listed.
 */
export const SpaceTemplateReadinessItemSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A readiness key is a kebab-case slug'),
    title: z.string().min(1).max(200),
    required: z.boolean(),
    answeredBy: z.string().refine((kind) => POST_INSTALL_TASK_KINDS.includes(kind), {
      message: 'answeredBy must name a post-install task kind',
    }),
    reading: z.enum(['machine', 'folder']).optional(),
    page: z
      .string()
      .min(2)
      .max(200)
      .regex(/^\/[a-z0-9/_-]+$/, 'A page is a space-relative route such as /computer')
      .optional()
      .describe('The space-relative page that changes the item'),
    command: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('The host CLI command that changes the item'),
  })
  .strict()
  .refine((item) => item.page !== undefined || item.command !== undefined, {
    message: 'A readiness item names the page or the command that changes it',
  })
  .refine((item) => item.reading === undefined || item.answeredBy === 'pair_machine', {
    message: 'reading names a pair_machine reading, and only that kind has two',
    path: ['reading'],
  })
  .refine((item) => REQUIRED_BY_KIND.get(item.answeredBy) === item.required, {
    message: 'required follows the kind that answers the item',
    path: ['required'],
  });
export type SpaceTemplateReadinessItem = z.infer<typeof SpaceTemplateReadinessItemSchema>;

/** A readiness item as read for one space. */
export const SpaceReadinessEntrySchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  required: z.boolean(),
  state: SpaceReadinessStateSchema,
  page: z.string().min(1).max(200).optional(),
  command: z.string().min(1).max(500).optional(),
});
export type SpaceReadinessEntry = z.infer<typeof SpaceReadinessEntrySchema>;

/**
 * The directives a template writes. They become the new space's own, so an
 * operator edits them as they edit any space's, and a later version of the
 * template never rewrites them.
 */
export const SpaceTemplateDirectivesSchema = EntityDirectivesSchema.pick({
  responsibility: true,
  priorities: true,
  style: true,
}).strict();
export type SpaceTemplateDirectives = z.infer<typeof SpaceTemplateDirectivesSchema>;

export const SpaceTemplateSchema = z
  .object({
    templateId: CatalogIdSchema,
    version: z.number().int().min(1),
    /** The name a space made from the template is offered under. */
    spaceName: z.string().min(1).max(255),
    /** Store bundles the template installs, by catalog id, in install order. */
    bundleIds: z.array(CatalogIdSchema).min(1).max(20),
    directives: SpaceTemplateDirectivesSchema,
    /** Agents written beyond the bundles' own; each starts a skill one of the bundles carries. */
    agents: z.array(BundledSkillStarterAgentSchema).max(10).default([]),
    /** api_definitions written beyond the bundles' own. */
    apiDefinitions: z.array(BundledApiDefinitionSchema).max(20).default([]),
    /** Help articles the template carries, by id. */
    help: z.array(HelpArticleIdSchema).max(20).default([]),
    readiness: z.array(SpaceTemplateReadinessItemSchema).max(20).default([]),
  })
  .strict()
  .refine((template) => new Set(template.bundleIds).size === template.bundleIds.length, {
    message: 'bundleIds must be unique',
    path: ['bundleIds'],
  })
  .refine(
    (template) =>
      new Set(template.readiness.map((item) => item.key)).size === template.readiness.length,
    { message: 'readiness keys must be unique', path: ['readiness'] },
  );
export type SpaceTemplate = z.infer<typeof SpaceTemplateSchema>;
export type SpaceTemplateInput = z.input<typeof SpaceTemplateSchema>;
