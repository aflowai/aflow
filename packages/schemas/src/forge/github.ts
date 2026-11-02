/**
 * GitHub's provider of the forge vocabulary (Plan 340 D2), as the schemas know
 * it: the API definition its acts call, the response transforms that shape
 * GitHub's answers into the vocabulary's records, GitHub's words for a check
 * run's conclusion, and the field names that are GitHub's alone.
 *
 * Nothing outside GitHub's provider imports from here but the vocabulary's
 * registry and the tests that pin GitHub's behaviour.
 */

/** The API definition every GitHub act calls (D4): one per forge. */
export const GITHUB_API_ID = 'github';

/** The git hosts whose repositories GitHub's provider answers for. */
export const GITHUB_FORGE_HOSTS: readonly string[] = ['github.com'];

/**
 * The response transforms (`response.transformPresetId`) that shape GitHub's
 * answers into the vocabulary's records, before anything is cut to fit inline:
 * a shepherd's rules read these fields, never GitHub's own, and a list too
 * long to inline would otherwise reach them as a summary. `pullRequests` and
 * `pullRequest` take the folder's prefix after a colon — `loop_pulls:aflow/`.
 * A pass aimed at one pull request reads it by its number and lists none.
 * `pullRequests` may take, after the prefix and a colon, the number of the pull
 * request the last such pass tended — `loop_pulls:aflow/:94` — and then lists
 * the one after it first.
 * `handoff` takes the login the loop posted the pinned handoff as and the pull
 * request's number, `loop_handoff:aflow-bot:94`: a record from any other author,
 * or on another pull request, is no record. With no login, `loop_handoff::94`,
 * no record is trusted. A login holds no colon. Where the pinned comment is
 * gone, the read of the newest page also takes the attempt state the pin
 * kept — `loop_handoff:aflow-bot:94:2:555`, the failures acted on and the
 * check run last acted on, which may be empty — so a deleted comment restarts
 * neither the budget nor the guard on a check run already acted on.
 *
 * The merge reads (Plan 321 D6): `requiredRules` shapes the base branch's
 * ruleset rules into the check names they require; `requiredProtection`
 * shapes the branch and its classic protection, taking the rules' names after
 * a colon, into the union of the two; `checkRuns` takes that union after a
 * colon and says of each required name whether a check run on the head
 * passed it. Names travel as {@link encodeRequiredChecks} writes them, since a
 * template joins text and nothing else. `reviews` shapes one page of reviews
 * into each person's standing verdict.
 */
export const SHEPHERD_RESPONSE_PRESETS = {
  pullRequests: 'loop_pulls',
  pullRequest: 'loop_pull',
  checkRuns: 'loop_checks',
  handoff: 'loop_handoff',
  failingJobs: 'loop_failing_jobs',
  requiredRules: 'loop_required_rules',
  requiredProtection: 'loop_required_protection',
  reviews: 'loop_reviews',
} as const;

/** `getJobLogs`' own transform: the log cut to its excerpt. */
export const JOB_LOG_TAIL_PRESET = 'job_log_tail';

/**
 * A set of check names as one line of text: each URI-encoded, so no name can
 * hold the separator, joined by commas in sorted order. The empty set is the
 * empty string, which is a set read and found empty — never a set unread.
 */
export function encodeRequiredChecks(names: Iterable<string>): string {
  return [...new Set(names)]
    .sort()
    .map((name) => encodeURIComponent(name))
    .join(',');
}

/** The names {@link encodeRequiredChecks} wrote. Throws on text it could not have written. */
export function decodeRequiredChecks(text: string): string[] {
  if (text === '') return [];
  return text.split(',').map((part) => {
    if (part === '') throw new Error('a required check name is empty');
    return decodeURIComponent(part);
  });
}

/**
 * The check run conclusions that fail a head: the only ones a shepherd pass
 * acts on. The pull request event source reads red from these alone, so it
 * fires `checks_failed` only on a head the pass reads as `failing`.
 */
export const CHECK_RUN_FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'startup_failure',
]);

/** Conclusions of a run stopped short of a verdict. A pass waits on them, so they are not red. */
export const CHECK_RUN_STOPPED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'cancelled',
  'action_required',
  'stale',
]);

/**
 * The names that are GitHub's alone: fields of its answers, parameters of its
 * endpoints and words of its replies that its provider reads or sends. The
 * forge seam's guard fails where one appears in the skills or the poller, and
 * also where one appears in none of GitHub's provider files, so the list
 * cannot outlive what it names. The guard adds the API definition's endpoint
 * ids and the response transforms' names to these.
 */
export const GITHUB_FORGE_FIELD_NAMES: readonly string[] = [
  'action_required',
  'check_runs',
  'comment_id',
  'details_url',
  'full_name',
  'html_url',
  'issue_number',
  'issue_url',
  'job_id',
  'merge_method',
  'mergeable_state',
  'per_page',
  'pull_number',
  'required_status_checks',
  'startup_failure',
  'timed_out',
  'total_count',
  'updated_at',
  'CHANGES_REQUESTED',
  'api.github.com',
  'X-GitHub-Api-Version',
  'application/vnd.github+json',
];
