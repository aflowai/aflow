import { SpaceSlugSchema, AgentSlugSchema } from './ids.js';

/**
 * Reserved space slugs. The `/s/` namespace prefix removes the top-level
 * collision concern (a space called `settings` no longer shadows the
 * top-level `/settings/...` route). What remains is a tiny defensive set of
 * command-like words that would read confusingly as a workspace name.
 *
 * Lowercase, hyphen-normalized — matches the slug shape exactly.
 */
export const SPACE_SLUG_RESERVED: ReadonlySet<string> = new Set([
  'new', // would read as "create a new space"
  'archived', // tenant-level `/spaces/archived` list is the archive view
  'all', // future-proofing for "all spaces" overview routes
]);

/**
 * Reserved agent slugs. Agents live under `/s/<space>/agents/<agentSlug>`,
 * which puts them at risk of shadowing the sibling sub-paths:
 *
 *   - `/s/<space>/agents/new`  ← "create a new agent"
 *
 * Plus the same defensive set of command-like words used for spaces.
 *
 * Reads (e.g. listing or resolving an existing agent named `edit` from
 * before this constraint existed) still work fine — only **new agent
 * creates / renames** are blocked.
 */
export const AGENT_SLUG_RESERVED: ReadonlySet<string> = new Set([
  'new', // collides with /s/<space>/agents/new
  'archived',
  'all',
]);

/** Discriminated outcome of a slug validation check. */
export type SlugValidation =
  | { ok: true }
  | { ok: false; code: 'SLUG_INVALID'; message: string }
  | { ok: false; code: 'SLUG_RESERVED'; message: string };

/**
 * Validate a candidate space slug. Combines syntactic (Zod) and semantic
 * (reserved-set) checks into a single discriminated result. Returns
 * `{ ok: true }` if the slug can be used; otherwise returns a typed error
 * with a human-readable message suitable for surfacing in `check-slug`
 * responses and form-validation hints.
 *
 * Does **not** check for collision with existing slugs or retired slug
 * history — that's the repository's job (raises `SLUG_TAKEN`).
 */
export function validateSpaceSlug(input: string): SlugValidation {
  const parsed = SpaceSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'SLUG_INVALID',
      message: parsed.error.issues[0]?.message ?? 'Invalid space slug',
    };
  }
  if (SPACE_SLUG_RESERVED.has(parsed.data)) {
    return {
      ok: false,
      code: 'SLUG_RESERVED',
      message: `"${parsed.data}" is a reserved space slug`,
    };
  }
  return { ok: true };
}

/**
 * Validate a candidate agent slug. See {@link validateSpaceSlug} for the
 * shape and semantics — same contract, different reserved set.
 */
export function validateAgentSlug(input: string): SlugValidation {
  const parsed = AgentSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'SLUG_INVALID',
      message: parsed.error.issues[0]?.message ?? 'Invalid agent slug',
    };
  }
  if (AGENT_SLUG_RESERVED.has(parsed.data)) {
    return {
      ok: false,
      code: 'SLUG_RESERVED',
      message: `"${parsed.data}" is a reserved agent slug`,
    };
  }
  return { ok: true };
}

/**
 * Derive a slug candidate from a human-entered name. Produces a string
 * that's **likely** to pass {@link validateSpaceSlug} or
 * {@link validateAgentSlug}, but the caller must still validate the output
 * (e.g. an all-emoji name will produce an empty string, which fails).
 *
 * Behaviour:
 *   - Lowercase the input.
 *   - Replace runs of non-`[a-z0-9]` characters with single hyphens.
 *   - Trim leading and trailing hyphens.
 *   - Truncate to 64 chars (at a hyphen boundary if possible, else hard).
 *
 * Idempotent on already-slugified inputs.
 *
 * Examples:
 *   slugify('Acme Corp')         → 'acme-corp'
 *   slugify('Stargate (Phase 2)') → 'stargate-phase-2'
 *   slugify('  Acme—Corp__v3 ')  → 'acme-corp-v3'
 *   slugify('🚀 launch')         → 'launch'
 *   slugify('🌟')                → ''  (caller must validate)
 */
export function slugify(name: string): string {
  const lowered = name.toLowerCase();
  // Replace runs of any non-[a-z0-9] with a single hyphen
  const normalized = lowered.replace(/[^a-z0-9]+/g, '-');
  // Trim leading/trailing hyphens
  const trimmed = normalized.replace(/^-+|-+$/g, '');
  if (trimmed.length <= 64) return trimmed;
  // Truncate at the last hyphen within 64 chars, falling back to hard cut.
  const head = trimmed.slice(0, 64);
  const lastHyphen = head.lastIndexOf('-');
  if (lastHyphen > 0) return head.slice(0, lastHyphen);
  return head;
}
