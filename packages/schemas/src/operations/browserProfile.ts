/**
 * A browser profile, as the machine that holds it declares it.
 *
 * Read by the host executor from its own policy file and relayed in the host
 * inventory. A workspace addresses a profile by id and can introduce none,
 * move none and change none: every field here is the operator's, written on
 * the machine.
 */
import { z } from 'zod';

/**
 * A profile id names a directory under the host directory, so it is held to
 * characters no path can climb out of.
 */
export const BrowserProfileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, {
  message:
    'A browser profile id is 1 to 64 letters, digits, `-` or `_`, starting with a letter or ' +
    'digit — it names the directory the profile keeps its sign-ins in.',
});

export const DEFAULT_BROWSER_PROFILE_ID = 'default';

export const BrowserPostureSchema = z
  .enum(['autonomous', 'ask-to-act', 'read-only'])
  .describe(
    '`autonomous`: navigation, reading and interaction run without asking. ' +
      '`ask-to-act`: reading and navigation run; every interaction waits for the operator. ' +
      '`read-only`: interaction is refused.',
  );
export type BrowserPosture = z.infer<typeof BrowserPostureSchema>;

export const BrowserOriginRuleSchema = z.object({
  origin: z
    .string()
    .min(1)
    .describe('The origin the rule applies to, such as `https://mail.example.com`.'),
  effect: z
    .enum(['allow', 'ask', 'deny'])
    .describe('What an action on a page at this origin does, over the posture.'),
});
export type BrowserOriginRule = z.infer<typeof BrowserOriginRuleSchema>;

export const BrowserProfileSchema = z.object({
  id: BrowserProfileIdSchema,
  spaces: z
    .union([z.literal('all'), z.array(z.string().min(1))])
    .default('all')
    .describe('The spaces that may use this profile: `all`, or a list of space ids.'),
  posture: BrowserPostureSchema.default('autonomous'),
  rules: z.array(BrowserOriginRuleSchema).default([]),
  window: z
    .enum(['hidden', 'visible'])
    .default('hidden')
    .describe('`hidden` runs the browser headless; `visible` gives it a window on this machine.'),
  unattended: z
    .boolean()
    .default(true)
    .describe('Whether a run nobody started by hand — a schedule, a trigger — may use it.'),
});
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;
