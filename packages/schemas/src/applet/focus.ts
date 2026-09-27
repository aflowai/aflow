/**
 * Session-scoped focus — which instance the agent is operating right now.
 * A browser mount is not server authority: two people may have different
 * instances open, and a waking action can nominate an instance with no view
 * mounted anywhere. Precedence: waking action → explicit focus → sole active
 * instance → none (no actions lowered).
 */
import { z } from 'zod';
import { AppletInstanceIdSchema } from './instance.js';
import { AppletStateVersionSchema } from './command.js';

export const AppletFocusSourceSchema = z.enum([
  'waking_action',
  'explicit_agent_focus',
  'user_mount',
]);
export type AppletFocusSource = z.infer<typeof AppletFocusSourceSchema>;

export const AppletFocusSchema = z.object({
  sessionId: z.string(),
  instanceId: AppletInstanceIdSchema,
  source: AppletFocusSourceSchema,
  /** State version captured when focus was set — stamped into lowered-tool metadata so a blind write is distinguishable from a considered one. */
  version: AppletStateVersionSchema,
  expiresAt: z.string().datetime().optional(),
});
export type AppletFocus = z.infer<typeof AppletFocusSchema>;

/**
 * A session's focus outlives any one turn but not the session's working life —
 * a day-old pointer at an instance nobody mentioned since is noise, and the
 * sole-active fallback recovers the common case for free.
 */
export const APPLET_FOCUS_TTL_SECONDS = 24 * 60 * 60;
