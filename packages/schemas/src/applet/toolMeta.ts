import { z } from 'zod';

/**
 * Binding an applet-action virtual tool carries to its ui.applet.act
 * lowering. The model never sees or supplies these — the dispatch reads
 * them from this turn's cached specs and mints the rest server-side.
 */
export const AppletToolMetaSchema = z.object({
  instanceId: z.string(),
  actionName: z.string(),
  patchMode: z.enum(['template', 'actor_supplied']),
  /** Instance stateVersion read at tool assembly — the blind-write base when the agent has not re-read. */
  baseVersion: z.number().int().nonnegative(),
});
export type AppletToolMeta = z.infer<typeof AppletToolMetaSchema>;
