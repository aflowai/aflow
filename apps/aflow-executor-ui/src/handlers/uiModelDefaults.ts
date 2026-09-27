/**
 * Kind-shaped preferences for UI generation, ordered behind the caller's
 * explicit choice and the scheduling agent's own model. These are
 * PREFERENCES, not pins: `resolveGenerationModel` only returns one the space
 * can actually resolve a credential for.
 */
export const DEFAULT_UI_MODEL = 'anthropic-sonnet';

/** Applets and illustrations lean on strong creative-coding and visual output. */
export const DEFAULT_APPLET_MODEL = 'google-pro';
