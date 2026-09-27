import { SkillConcurrencyPolicySchema, type SkillConcurrencyPolicy } from '@aflow/schemas';

/** The policy a run gets when nothing declares one. */
export function defaultConcurrencyPolicy(): SkillConcurrencyPolicy {
  return SkillConcurrencyPolicySchema.parse({});
}

/**
 * Resolve the policy to freeze on a run row from the skill manifest's
 * declaration, filling every unset field with its schema default.
 */
export function resolveEffectiveConcurrencyPolicy(
  manifestPolicy?: Partial<SkillConcurrencyPolicy>,
): SkillConcurrencyPolicy {
  return SkillConcurrencyPolicySchema.parse(manifestPolicy ?? {});
}

/**
 * Read the policy a run is executing under.
 *
 * Dispatch must never re-resolve the manifest: an edit landing mid-run would
 * change the limits of a run already in flight. Rows created before the column
 * carry NULL and fall back to the schema defaults.
 */
export function readPinnedConcurrencyPolicy(runRow: {
  effectiveConcurrencyPolicy: SkillConcurrencyPolicy | null;
}): SkillConcurrencyPolicy {
  const pinned = runRow.effectiveConcurrencyPolicy;
  if (pinned === null) {
    return defaultConcurrencyPolicy();
  }
  // A row written by an older shape can hold a partial object; the schema
  // fills the gaps rather than handing the scheduler an undefined limit.
  const parsed = SkillConcurrencyPolicySchema.safeParse(pinned);
  return parsed.success ? parsed.data : defaultConcurrencyPolicy();
}
