import { getAllOperations, TASK_DRAFT_PREFIX } from '@aflow/schemas';
import { canonicalizePath } from '@aflow/database';

const EVAL_SUITE_PATH_RE = /^\/evals\/[^/]+\/suite\.json$/u;

/**
 * A document is stored at its canonical path, so governance has to read the
 * same form the row lands on: a caller who spells `//media/x` or `/media/./x`
 * reaches the governed row either way, and a guard that reads the spelling
 * instead of the destination is a guard that spelling walks around.
 */
function canonicalOrNull(path: string | null | undefined): string | null {
  return typeof path === 'string' ? canonicalizePath(path) : null;
}

export function isGovernedEvalSuitePath(path: string | null | undefined): path is string {
  const canonical = canonicalOrNull(path);
  return canonical !== null && EVAL_SUITE_PATH_RE.test(canonical);
}

function governedEvalSuiteMutationMessage(path: string): string {
  return (
    `Direct changes to ${path} are blocked. ` +
    'Update eval suites via learner.propose.workflow_change with eval.criterion.* ops, then ratify.'
  );
}

/**
 * The platform writer a governed prefix belongs to. A write under such a prefix
 * is refused unless it names the writer that owns it, so the prefix reads as
 * executor-only to everything else.
 */
export type GovernedWriter = 'generated_media';

export const GENERATED_MEDIA_PREFIX = '/media/';

/**
 * Where a paid render's bytes, receipt and note live. The address of an asset is
 * derived from the request that paid for it, so an agent writing at one either
 * fails the render that has not landed yet or separates a landed one from the
 * receipt that describes it.
 */
export function isGeneratedMediaPath(path: string | null | undefined): path is string {
  return canonicalOrNull(path)?.startsWith(GENERATED_MEDIA_PREFIX) === true;
}

/**
 * The operations that write under the prefix, read from the registry. A
 * hand-spelled list names an operation the moment one is renamed or added, and
 * this refusal is the only place an agent is told what does write here.
 */
function generatedMediaWriters(): string {
  return Array.from(getAllOperations().values())
    .filter((operation) => operation.stepType === 'ai' && operation.group === 'media')
    .map((operation) => operation.operationId)
    .sort()
    .join(', ');
}

function generatedMediaMutationMessage(path: string): string {
  return (
    `Direct changes to ${path} are blocked. ` +
    `\`/media/**\` holds generated renders and is written only by ${generatedMediaWriters()}, ` +
    'which address each asset by the request that paid for it. An asset, its receipt and its ' +
    'note are one record of one paid render: editing or removing any of them leaves the rest ' +
    'describing something that is no longer there. ' +
    'Read one with memory.store.get; produce a new one by calling the media operation again; ' +
    'store your own files under a path of your own.'
  );
}

/**
 * A workflow's definition, its activation and its revision history — what
 * `workflow.run.start` reads and what ratification writes. Other documents a
 * skill keeps under its `/workflows/{slug}/` folder (a data cache, notes) stay
 * ordinary memory.
 */
const WORKFLOW_DEFINITION_PATH_RE =
  /^\/workflows\/[^/]+\/(?:workflow\.json|activation\.json|revisions\/.+)$/u;

/**
 * A skill's manifest carries its goal and campaign contract, which change only
 * by a ratified proposal — the same authority as the workflow it points at.
 */
const SKILL_MANIFEST_PATH_RE = /^\/skills\/[^/]+\/manifest\.json$/u;

/** Directories whose removal takes a workflow definition with them. */
const WORKFLOW_DEFINITION_SUBTREE_RE =
  /^\/(?:workflows\/(?:[^/]+\/(?:revisions\/)?)?|skills\/(?:[^/]+\/)?)$/u;

export function isWorkflowDefinitionPath(path: string | null | undefined): path is string {
  const canonical = canonicalOrNull(path);
  return (
    canonical !== null &&
    (WORKFLOW_DEFINITION_PATH_RE.test(canonical) || SKILL_MANIFEST_PATH_RE.test(canonical))
  );
}

function workflowDefinitionMutationMessage(path: string): string {
  return (
    `Direct changes to ${path} are blocked. ` +
    'A workflow definition and a skill manifest are changed with workflow.manage.patch, where a definition change becomes a ' +
    'proposal the operator ratifies, and only the operator approves a workflow. ' +
    'Create a new workflow with workflow.manage.put. An operator edits a workflow from its skill page.'
  );
}

const PLATFORM_EVIDENCE_PREFIX = '/coach/evidence/';

export function isPlatformEvidencePath(path: string | null | undefined): path is string {
  return canonicalOrNull(path)?.startsWith(PLATFORM_EVIDENCE_PREFIX) === true;
}

export function isTaskDraftPath(path: string | null | undefined): path is string {
  return canonicalOrNull(path)?.startsWith(TASK_DRAFT_PREFIX) === true;
}

function taskDraftMutationMessage(path: string): string {
  return (
    `Direct changes to ${path} are blocked. ` +
    'A task draft is written only through `draft_patch`, which carries the revision, replay key ' +
    'and atomicity that a generic write has not got. Editing it underneath those loses a ' +
    'concurrent patch silently.'
  );
}

function platformEvidenceMutationMessage(path: string): string {
  return (
    `Direct changes to ${path} are blocked. ` +
    '`/coach/evidence/**` is platform-only — evidence documents are written by the api.http.call / mcp.tools.call executors when they perform real source calls. ' +
    "If you need to certify real-source data, call the granted API tool and pass the response's `sourceEvidenceRef` through into your provenance block."
  );
}

const GOVERNED_PREFIXES: readonly string[] = [
  '/evals/',
  PLATFORM_EVIDENCE_PREFIX,
  GENERATED_MEDIA_PREFIX,
  TASK_DRAFT_PREFIX,
];

/**
 * Why a directory removal is refused, or null when it is not. Everything under
 * a directory goes with it, and the per-document guard never sees any of it
 * because the caller names only the directory — so a directory is refused both
 * when it holds a governed prefix and when it sits inside one. Only the second
 * direction covers a governed document whose own path is not the governed one:
 * `/evals/<skill>` holds a suite this refusal is the only guard for.
 */
export function governedSubtreeRefusal(path: string | null | undefined): string | null {
  const canonical = canonicalOrNull(path);
  if (canonical === null) return null;
  const subtree = canonical.endsWith('/') ? canonical : `${canonical}/`;
  if (WORKFLOW_DEFINITION_SUBTREE_RE.test(subtree)) {
    return (
      `Deleting ${canonical} is blocked because it removes a workflow definition, which changes ` +
      'only through workflow.manage.patch and the operator. Delete the documents you own by naming them.'
    );
  }
  const governed = GOVERNED_PREFIXES.find(
    (prefix) => prefix.startsWith(subtree) || subtree.startsWith(prefix),
  );
  if (governed === undefined) return null;
  return (
    `Deleting ${canonical} is blocked because it removes documents under \`${governed}**\`, ` +
    'which the platform writes and owns. Delete the documents you own by naming them.'
  );
}

/**
 * Why this path refuses the mutation being attempted, or null when it does not.
 * Every mutation asks the same question: a delete removes what a governed
 * writer owns and a patch rewrites it, so neither can be governed less than the
 * write that produced it.
 *
 * `writer` is the platform writer performing the mutation — the prefix it owns
 * is the only one it is exempt from.
 */
/**
 * A task draft is the private scratch of one run's attempt, and governance on
 * writes alone does not make it private: `memory.store.get` resolves any path
 * with only a `spaceId`, and a listing can enumerate the prefix, so another
 * actor or another run in the same space could read it. The write guard is
 * about integrity; this one is about who can see it at all.
 *
 * `draft_get` remains the way in, because its scope is derived from the session
 * on the server rather than named by the caller.
 */
export function taskDraftReadRefusal(path: string | null | undefined): string | null {
  const canonical = canonicalOrNull(path);
  if (canonical === null || !isTaskDraftPath(canonical)) return null;
  return (
    `${canonical} is another run's private scratch and cannot be read here. ` +
    'Use `draft_get` to read the draft belonging to this task attempt.'
  );
}

export function governedPathRefusal(
  path: string | null | undefined,
  writer?: GovernedWriter,
): string | null {
  const canonical = canonicalOrNull(path);
  if (canonical === null) return null;
  if (isGovernedEvalSuitePath(canonical)) return governedEvalSuiteMutationMessage(canonical);
  if (isPlatformEvidencePath(canonical)) return platformEvidenceMutationMessage(canonical);
  if (isWorkflowDefinitionPath(canonical)) return workflowDefinitionMutationMessage(canonical);
  // Checked on the RESOLVED path, so a draft reached by document id is refused
  // too — the id route bypasses every path-shaped guard upstream.
  if (isTaskDraftPath(canonical)) return taskDraftMutationMessage(canonical);
  if (isGeneratedMediaPath(canonical) && writer !== 'generated_media') {
    return generatedMediaMutationMessage(canonical);
  }
  return null;
}
