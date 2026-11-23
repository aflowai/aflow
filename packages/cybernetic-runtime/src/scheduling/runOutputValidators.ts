import {
  getAdvisoryValidator,
  lookupValidator,
  type AdvisoryFinding,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import { getCyberneticLogger } from '../logger.js';

export interface OutputValidatorIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * The issue an unregistered `validatorRef` gives. No output can pass a rule
 * the platform does not hold, so the ref refuses every output.
 */
export function unregisteredValidatorIssue(ref: string): OutputValidatorIssue {
  return {
    path: [],
    message: `The output contract names the validator "${ref}", which this platform does not register, so no output can pass it. Do not resubmit. The skill's contract has to change before this task can complete.`,
  };
}

/**
 * Run each `validatorRef` against `data`. Pure validators run via `safeParse`.
 * Runtime validators run with the space-scoped context. An unregistered ref
 * refuses the output, because a rule that never ran has accepted nothing.
 */
export async function runRegisteredOutputValidators(
  refs: string[],
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<OutputValidatorIssue[]> {
  const issues: OutputValidatorIssue[] = [];
  for (const ref of refs) {
    const v = lookupValidator(ref);
    if (!v) {
      getCyberneticLogger().warn(
        `[outputValidators] validatorRef "${ref}" is not registered; refusing the output.`,
      );
      issues.push(unregisteredValidatorIssue(ref));
      continue;
    }
    if (v.kind === 'pure') {
      const result = v.schema.safeParse(data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ path: issue.path, message: issue.message });
        }
      }
    } else {
      const runtimeIssues: RuntimeValidatorIssue[] = await v.fn(data, ctx);
      for (const issue of runtimeIssues) {
        issues.push({ path: issue.path, message: issue.message });
      }
    }
  }
  return issues;
}

/** Format issues into the leading-`/path` lines Ajv output uses (uniform surface). */
export function formatOutputValidatorIssues(issues: OutputValidatorIssue[]): string[] {
  return issues.map((i) => {
    const loc = i.path.length > 0 ? `/${i.path.join('/')}` : '(root)';
    return `${loc}: ${i.message}`;
  });
}

/**
 * What the output would pass with and still be weak at.
 *
 * Advisories refuse nothing, so this runs only after the blocking validators
 * have accepted — reporting the same artifact in two registers would teach an
 * author that advisories are errors. It is the half no gate can express: the
 * suite that satisfies every schema and checks none of what it declares. A
 * one-case draft titled "Probe", with a requirement and no expectation,
 * passed every blocking validator and completed its run.
 *
 * Silence here is not endorsement — these validators look for specific known
 * weaknesses, not for quality — so callers must report findings and say
 * nothing at all when there are none.
 */
export function runRegisteredAdvisories(refs: string[], data: unknown): AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  for (const ref of refs) {
    const fn = getAdvisoryValidator(ref);
    if (!fn) continue;
    try {
      findings.push(...fn(data));
    } catch (err) {
      // An advisory that throws must never cost an author an accepted output.
      getCyberneticLogger().warn(
        `[outputValidators] advisory "${ref}" threw (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return findings;
}
