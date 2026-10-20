import {
  SkillBundleSchema,
  type SkillBundle,
  type SkillBundleId,
  type SkillBundleInput,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from './skillCatalog.js';
import { TEST_TWO_SKILL_BUNDLE, TEST_SETUP_BUNDLE } from './skillBundleCatalog/testFixtures.js';
import { ALPACA_THESIS_TRADING } from './skillBundleCatalog/alpacaThesisTrading.js';
import { TICKER_DIGEST } from './skillBundleCatalog/tickerDigest.js';
import { WEB_RESEARCH_BRIEF } from './skillBundleCatalog/webResearchBrief.js';
import { LITERATURE_SCAN } from './skillBundleCatalog/literatureScan.js';
import { FILM_SHOT_BATCH } from './skillBundleCatalog/filmShotBatch.js';
import { EVAL_SUITE_DESIGN } from './skillBundleCatalog/evalSuiteDesign.js';
import { KAGGLE_API_DEFINITION } from './skillBundleCatalog/kaggleApiDefinitions.js';
import { GITHUB_API_DEFINITION } from './skillBundleCatalog/githubApiDefinitions.js';

/**
 * A bundle as authored: `revision` in place of the version the Store
 * publishes, which `publishedBundleVersion` derives. The Store offers an
 * update when a bundle's version passes the one a space installed and reads
 * no skill's version for that, so a skill raised under a bundle that stayed
 * was never offered; derived, a skill that moves moves its bundle. `revision`
 * is raised for a change to the bundle itself, and for a skill it stops
 * carrying, whose version then leaves the sum. It is negative where a bundle
 * was released below the sum of its skills' versions, so that the version it
 * publishes continues from the one it had.
 */
export type AuthoredSkillBundle = Omit<SkillBundleInput, 'version'> & {
  readonly revision: number;
};

/** A bundle's published version: its revision plus the version of every skill it carries. */
export function publishedBundleVersion(
  bundle: Pick<AuthoredSkillBundle, 'bundleId' | 'revision' | 'skillCatalogIds'>,
): number {
  return bundle.skillCatalogIds.reduce((version, catalogId) => {
    const skill = getSkillCatalogEntry(catalogId);
    if (skill === null) {
      throw new Error(
        `Bundle "${bundle.bundleId}" carries "${catalogId}", which is no skill in the catalog, so it has no version to publish.`,
      );
    }
    return version + skill.version;
  }, bundle.revision);
}

// ============================================================================
// kaggle-competition — Kaggle competition optimizer
// ============================================================================

const KAGGLE_API_TOKEN_CREDENTIAL_KEY = 'kaggle-api-token';

const KAGGLE_COMPETITION_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'kaggle-competition' as SkillBundleId,
  revision: 2,
  name: 'Kaggle Competition',
  tagline: 'Iterate toward a target leaderboard score on a Kaggle competition.',
  description: `Wires up the **Kaggle REST API** and the **Kaggle Competition Optimizer** skill — an iterative loop that prepares a competition, proposes a strategy informed by prior runs, implements it in a sandbox, submits (approval-gated), polls the leaderboard, and records structured learnings for the next iteration.

**What you get**:
- The **Kaggle** API definition (list data files, download data, request a submission upload, submit, poll submission status) + a default Bearer binding ready to receive your Kaggle API token.
- The **Kaggle Competition Optimizer** skill — a campaign-driven workflow (prepare → execute → approve → submit chain → poll leaderboard → extract → record).

**After install**:
1. Go to **Integrations → API integrations → Kaggle** and paste your Kaggle API token (a \`KGAT_…\` token) as the binding credential.
2. **Join each competition** you want to enter (accept its rules) on kaggle.com — the submit/status endpoints reject an account that hasn't joined.
3. Start a campaign for a competition (the skill collects the competition slug, metric, direction, and target) and run it. Each submission asks for your approval before consuming Kaggle daily quota.`,
  tags: ['kaggle', 'ml', 'optimization', 'competitions'],
  skillCatalogIds: ['kaggle-competition-optimizer'],
  prerequisiteBundleIds: [],
  // `kaggle-data-fetch` is a credential-less direct-URL binding for the signed
  // Google Cloud Storage URLs the data-download (GET) and submission-upload
  // (PUT) flows use; its egressPolicy.allowedHosts is the security boundary.
  apiDefinitions: [
    KAGGLE_API_DEFINITION,
    {
      apiId: 'kaggle-data-fetch',
      definition: {
        name: 'Kaggle Data Fetch',
        baseUrl: 'https://www.kaggle.com',
        authKind: 'none' as const,
        // Direct-URL binding: no endpoints — agents call signed Google Storage
        // URLs via api.http.call direct-URL mode (apiId + bindingId + url),
        // gated by the binding's egress allowlist.
        callMode: 'direct_url' as const,
        endpoints: [],
      },
      conflictPolicy: 'skip' as const,
    },
  ],
  apiBindingTemplates: [
    {
      bindingId: 'kaggle-default',
      apiId: 'kaggle',
      name: 'Default',
      description:
        'Bearer-auth access to the Kaggle REST API. Paste your Kaggle API token (a KGAT_… token) as the credential. The binding stays unconfigured until the token is set in Integrations.',
      authShape: { type: 'bearer' as const },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: KAGGLE_API_TOKEN_CREDENTIAL_KEY,
          role: 'token' as const,
          label: 'Kaggle API token',
        },
      ],
      egressPolicy: {
        // The data-download endpoint 302s to a signed Google Cloud Storage URL.
        // The executor follows the redirect without the Bearer, which stays
        // with kaggle.com and a signed URL does not need, and downloads the
        // file in one call.
        allowedHosts: [
          'www.kaggle.com',
          'storage.googleapis.com',
          '*.storage.googleapis.com',
          'storage.cloud.google.com',
          'www.googleapis.com',
          'uploads.googleapis.com',
        ],
        allowedMethods: ['GET' as const, 'POST' as const],
        allowCrossHostRedirects: true,
        // Up to 100 MB for the GCS-hosted data files (tabular competitions).
        maxResponseBodyBytes: 104_857_600,
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'kaggle-data-fetch-default',
      apiId: 'kaggle-data-fetch',
      name: 'Default',
      description:
        "Direct-URL fetch binding for Kaggle competition data + submission uploads. allowedHosts pins egress to www.kaggle.com plus Google's blob hosts (the signed download/upload URLs are hosted there). No credentials required — signed URLs are self-authorizing.",
      authShape: { type: 'none' as const },
      credentialSlots: [],
      egressPolicy: {
        // GCS hosts the signed download/upload URLs resolve to. The blobs/upload
        // resumable-upload URL lands on www.googleapis.com; without it the
        // PUT-bytes step fails egress and the submission never lands.
        allowedHosts: [
          'www.kaggle.com',
          'storage.googleapis.com',
          '*.storage.googleapis.com',
          'storage.cloud.google.com',
          'www.googleapis.com',
          'uploads.googleapis.com',
        ],
        // GET for downloads, PUT for the resumable submission upload.
        allowedMethods: ['GET' as const, 'PUT' as const],
        maxResponseBodyBytes: 104_857_600,
        // The submission upload PUTs the submission.csv from a memory path; a
        // real competition's submission runs to several MB, past the 1 MB
        // request default. Symmetric with the download response cap.
        maxRequestBodyBytes: 104_857_600,
      },
      conflictPolicy: 'skip' as const,
    },
  ],
  memorySeed: [],
  helmsmanHints: [
    'After install, go to Integrations → API integrations → Kaggle and paste the Kaggle API token (a KGAT_… token) as the binding credential.',
    'Tell the operator to JOIN each competition (accept its rules) on kaggle.com before running — the Kaggle submit/status endpoints reject an account that has not joined the competition.',
    'Submissions are approval-gated — every submission produces an approval request before consuming Kaggle daily quota or appearing on the public leaderboard.',
    'To run the Kaggle Competition Optimizer, call workflow.run.start({ slug }). The first run for a competition rejects with CAMPAIGN_REQUIRED carrying the contract fields (competition slug, metric name, direction minimize|maximize, target score) — collect them once and re-issue workflow.run.start({ slug, campaignConfig: { … } }), which creates the campaign and starts the run. Later runs need only { slug }; to run a different competition while one is active, pass its campaignConfig again.',
  ],
};

// ============================================================================
// coding-pr-loop — the implement ↔ review coding loop
// ============================================================================

const CODING_PR_LOOP_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'coding-pr-loop' as SkillBundleId,
  revision: 1,
  name: 'Coding PR Loop',
  tagline: 'Open, review, and iterate pull requests on your repo with a coding agent.',
  description: `Wires up the **GitHub REST API** and the three coding skills that drive the **implement ↔ review loop**: open a PR from a request, adversarially review it, and revise it on the same branch toward passing.

**What you get**:
- The **GitHub** API definition (pull requests, files/diff, check-runs, reviews, comments, merge).
- **Open PR from Request** — frames a request, opens a PR (create mode) or revises an existing PR branch (fix mode).
- **Review Pull Request** — an adversarial reviewer (scoped lens + depth) that posts a verdict.
- **PR Shepherd** — tends an open PR toward merge (CI, reviews, fix, merge).

Then run a coding skill: ask to open a PR for a change → review it → fix → review.`,
  tags: ['coding', 'github', 'pull-requests', 'developer-tools', 'review'],
  skillCatalogIds: ['open-pr-from-request', 'review-pull-request', 'pr-shepherd'],
  prerequisiteBundleIds: [],
  apiDefinitions: [GITHUB_API_DEFINITION],
  // No pre-shipped GitHub binding: the connection is ensured when the operator
  // designates the repo (Plan 222 P3) — they paste a PAT (bootstrap) or link an
  // existing GitHub connection, and the repo designation resolves both git + the
  // PR API through it. A pre-shipped placeholder binding would only collide with
  // that bootstrap.
  apiBindingTemplates: [],
  memorySeed: [],
  // Repo designation is a required setup step that is DERIVED at install time
  // (the `designate_repo` post-install task fires while the space has no ready
  // repo), so it lives in the manifest, not here. Hints carry only optional
  // usage guidance.
  helmsmanHints: [
    'Once a repository is added, run “Open PR from Request” on it — it shows you the plan to approve before any code is written.',
  ],
};

// ============================================================================
// local-commission — have the machine's coding agent make a change
// ============================================================================

const LOCAL_COMMISSION_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'local-commission' as SkillBundleId,
  revision: 0,
  name: 'Local Commission',
  tagline: "Have the machine's own coding agent make a change in a connected repository.",
  description: `Installs **Commission Change** — a brief handed to the coding agent already installed on the machine, carried out in an isolated checkout of a repository connected as a folder, with the change returned as a stored patch.

**What it installs**:
- The **Commission Change** skill — one task that starts the checkout at the base the brief names, merges \`origin/<base>\` first where the brief asks, and returns the patch with the base it was made against, the merge it carries, whether it still applies, and the session a further turn continues. The connected folder's working tree is never touched, and nothing is committed or pushed.

**After install**: connect the repository as a folder, then commission a change with a brief. A commission runs for tens of minutes: start it with \`wait: 'none'\` and its end wakes the conversation. Publishing the patch is Local Publish.`,
  tags: ['coding', 'commission', 'local', 'developer-tools'],
  skillCatalogIds: ['commission-change'],
  prerequisiteBundleIds: [],
  apiDefinitions: [],
  apiBindingTemplates: [],
  memorySeed: [],
  helmsmanHints: [
    "A brief names the checks the coding agent runs, and they are the folder's own — its tests, type check, linter and formatter. The folder's declared checks run only once the patch is published.",
  ],
};

// ============================================================================
// local-code-review — review committed changes in a connected repository
// ============================================================================

const LOCAL_CODE_REVIEW_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'local-code-review' as SkillBundleId,
  revision: 0,
  name: 'Local Code Review',
  tagline: 'Review committed changes in a connected repository with the installed coding agent.',
  description: `Installs **Review Local Changes** — a read-only review of a revision range in a repository connected as a folder, carried out by the coding agent already installed on that machine.

**What it installs**:
- The **Review Local Changes** skill — one task that reads the range in an isolated checkout, with the whole repository around it, and returns a verdict with findings that name their file, line and evidence. At depth \`deep\` it also runs the project's own checks over the touched files.

**After install**: connect the repository as a folder, then ask for a review of a range — \`main..HEAD\`, the last few commits, a single sha. Only committed work is visible to the review, and nothing it finds is applied: a fix is separate work.`,
  tags: ['coding', 'review', 'local', 'developer-tools'],
  skillCatalogIds: ['review-local-changes'],
  prerequisiteBundleIds: [],
  apiDefinitions: [],
  apiBindingTemplates: [],
  memorySeed: [],
  helmsmanHints: [
    "The review reads the connected folder's commits, checked out at the commit the range ends at, so uncommitted work is invisible to it — ask for the work in progress to be committed, on a branch, before reviewing it.",
  ],
};

// ============================================================================
// local-publish — publish a patch to a branch and a pull request
// ============================================================================

const LOCAL_PUBLISH_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'local-publish' as SkillBundleId,
  revision: 0,
  name: 'Local Publish',
  tagline:
    'Commit a patch onto a branch of a connected repository, clear the push, and open the pull request.',
  description: `Installs **Publish Local Changes** — the step after a commission: a patch becomes a commit on a branch of a repository connected as a folder — a new one, or the branch a fix was commissioned from, and then, once the push is cleared, a pushed branch and an open pull request.

**What it installs**:
- The **Publish Local Changes** skill — the patch is committed in a detached worktree, so the working tree is untouched: a fresh branch starts at the commission's base, and the branch a fix was commissioned from is appended to at its head; the checks the folder declares run in a checkout of the commit, and a failure stops the run with nothing scanned or pushed — save one where only tests ran out of their time, which a loaded machine causes and the run checks once more — the push itself is refused without the receipt of their passing on that commit; everything the push would add — the commit and any of the folder's own commits under it that \`origin\` does not have yet — is scanned for secrets, with the commits' headers and messages and the pull request's title and summary, and a finding stops the run with nothing pushed; the run then waits for the operator's approval — unless the folder's push approval, or the decision on a review's findings, says it need not ask or must not push — and only after that is that commit pushed to its branch on \`origin\` — refused, with nothing pushed, where \`origin\`'s base no longer holds what the run measured or \`origin\` pushes elsewhere than it fetches — and the pull request opened, or the one the branch already has reported.

**After a review with findings**: an approving review whose findings are nits alone ends the rounds, so the run records \`publish_as_is\` for it without asking a decision model, as it does for an approving review that found nothing. Under any other verdict, whatever was found, or over a minor or worse, the run decides whether they are fixed before the branch merges, records the answer as \`afterReview\` on the run and on the pull request, and its push gate follows it. \`fix_before_merge\` pushes nothing and asks nothing: the run completes with the decision and findings recorded and the branch on the machine. \`publish_as_is\` pushes without asking over minor findings and nits, and the pull request lists the findings it leaves open; over a blocker or a major it waits for the operator, as \`undecided\`, where no answer cleared the bar, does. A folder whose push approval is \`always\`, or a range the scan did not clear, asks whatever was decided. A publication never starts a commission or another publication: on \`fix_before_merge\` the conversation — or the shepherd — commissions the fix round on the branch, briefed from every finding of the review run the publication names as \`reviewRunId\`, and publishes again.

**After install**: connect the repository as a folder allowing pushes under a branch prefix, and bind the GitHub connector for the space. Then hand the skill a commission's \`patchRef\`, a branch name under that prefix and a title. To have a publication run the repository's own checks first, declare them on the machine: \`aflow harness checks <folder> -- <program> [args...]\`, run from the repository root. A folder that declares none runs none, and the pull request's checks remain the proof.

**When it asks before pushing**: the folder's push approval, set on the machine that holds it — \`always\` asks before every push, \`never\` pushes without asking, and \`unless-unreviewed\` has the publication run a Local Code Review of everything the push would add and follow the decision on its findings, or, where it found none, push without asking only when it returns \`approve\`. \`unless-unreviewed\` is the default. Every publication scans what the push would carry before it, whatever the posture, which is what lets a review stand in for the approval. Where the scan could not read a file whole — binary, a NUL byte, too large, a line too long, a Git LFS pointer — or a line that looks like a secret carries an \`aflow-scan: allow\` comment, no review runs and the run asks the operator under every posture, \`never\` included, naming each. Change it with \`aflow harness push-approval <folder> <always|never|unless-unreviewed>\`.`,
  tags: ['coding', 'publish', 'git', 'local', 'developer-tools'],
  skillCatalogIds: ['publish-local-changes'],
  // A publication from an `unless-unreviewed` folder starts Review Local
  // Changes on what its push would add, so that skill has to be in the space.
  prerequisiteBundleIds: ['local-code-review' as SkillBundleId],
  // The GitHub definition ships so the pull-request call has an API to resolve
  // and the post-install manifest can surface its credential row; the
  // connection itself is the operator's, bound in Integrations.
  apiDefinitions: [GITHUB_API_DEFINITION],
  apiBindingTemplates: [],
  memorySeed: [],
  helmsmanHints: [
    'A folder connected without a publish prefix can be committed to but not pushed from — the push is refused where it runs. Ask for the folder to be reconnected allowing pushes under a prefix before starting a publication.',
    "Whether the run waits at the approval is the folder's push approval, shown in the machine block. Under `unless-unreviewed`, the default, the run reviews everything its push would add before it gets there, so no review needs starting alongside it. A file the scan could not read or a line marked `aflow-scan: allow` makes it ask under every posture.",
    "The folder's checks, where it declares them — `checks` in the machine block — run on the commit before anything else, so no build or test needs running beside a publication. A failed check fails the run with the end of what it printed, and nothing has left the machine; one that failed only on tests running out of time is run once more by the publication itself first, so it needs no retry from the conversation.",
    "A publication's push follows its `afterReview`, and so do you. On `fix_before_merge` it pushed nothing and the fix round is yours: commission it on the branch (`base: <branch>`) briefed from every finding of the `reviewRunId` run, then publish again passing the run's `findings`, its fixed ones marked closed. Publish over it only on an act the publication verifies — the operator's word, the `hands-off` label — passing `override` with `by` and the reason; never skip the round silently.",
    "A commission's change is published by its `patchRef`, never its `patch` text: that copy is cut short on a large change, and a run's inputs are capped at 32 KB together. `patch` is for a small diff the operator hands over.",
  ],
};

// ============================================================================
// local-shepherd — tend the loop's pull requests through CI
// ============================================================================

const LOCAL_PR_SHEPHERD_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'local-shepherd' as SkillBundleId,
  revision: 0,
  name: 'Local PR Shepherd',
  tagline:
    "Fix what CI fails on the pull requests the loop opened, through Local Publish, and merge a green one where the folder's merge posture allows — never approving or closing.",
  description: `Installs the **Local PR Shepherd** skill and the agent that starts it.

**What it installs**:
- The **Local PR Shepherd** skill — one pass over the pull requests Local Publish opened from a connected folder: it reads their CI, its own handoff comment and the work in flight on each branch, decides by rules — fix, merge, wait, abandon or leave — and for a red check commissions the fix on the branch and publishes it through Local Publish, which asks the operator exactly where it would when started by hand. A check run is acted on once, and a pull request labelled \`hands-off\` is left untouched. Where the folder's merge posture is \`when-green\` — \`aflow harness merge-posture <folder> when-green\`, beside the push approval \`unless-unreviewed\` — a green pull request whose required checks passed on its head, whose head the publication's review approved and on which no person requests changes is merged by squash, on the operator's approval of that merge.
- The **Local PR Shepherd** agent, under the skill's own slug — one step that starts the skill on the space's connected folder, and no model turn. It is what a schedule starts. It is written only where the space has exactly one folder that allows pushes; otherwise the install says so, and updating the bundle once the folder is connected writes it.

**After install**: connect the repository as a folder with a publish prefix, bind the GitHub connector with a token that reads checks, branches and Actions and writes comments — and merges pull requests, where the folder merges; the binding needs no host but api.github.com — a job's log, served from a signed URL on Azure blob storage, is followed without the token. Then run the agent, or start the skill with the folder's \`bindingId\`, and \`pullNumber\` to aim the pass at one pull request.`,
  tags: ['coding', 'github', 'ci', 'local', 'developer-tools'],
  skillCatalogIds: ['local-pr-shepherd'],
  // Every fix is published by Local Publish, which has to be in the space.
  prerequisiteBundleIds: ['local-publish' as SkillBundleId],
  apiDefinitions: [GITHUB_API_DEFINITION],
  apiBindingTemplates: [],
  memorySeed: [],
  agents: [
    {
      kind: 'skill_starter',
      skillCatalogId: 'local-pr-shepherd',
      name: 'Local PR Shepherd',
      description:
        "Starts one pass of the Local PR Shepherd on the space's connected folder. It decides nothing: the skill reads, decides and acts.",
      folderInput: 'bindingId',
    },
  ],
  helmsmanHints: [
    'A pass is one run of the skill over the folder: start the Local PR Shepherd agent, or workflow.run.start local-pr-shepherd with the folder’s bindingId — and pullNumber to aim it at one pull request. Its decision and reason are in its result and in the handoff comment on the pull request.',
    'The shepherd never approves or closes. A fix it publishes waits at Local Publish’s approval where the folder’s posture asks; a merge, only under the folder’s merge posture when-green (mergePosture in the machine block), waits at the merge’s own write approval. Both approvals are the operator’s, in the Action Center.',
    'A space with the GitHub definition from an earlier Local Publish needs Local Publish updated from the Store for the endpoints the shepherd reads — the jobs of a run, the end of a job’s log, a branch and its rules, and the merge pinned to a head.',
  ],
};

// ============================================================================
// Registry
// ============================================================================

/**
 * Raw entries authored in this file. Every entry is parsed through
 * `SkillBundleSchema` at module load below — catches typos, malformed
 * refinements (e.g., `setupSkillCatalogId` not in `skillCatalogIds`),
 * and bounds violations at import time rather than at install time.
 *
 * Use `SKILL_BUNDLE_CATALOG` (the validated, frozen export) elsewhere
 * — never iterate this raw array directly outside this module.
 */
const RAW_BUNDLES: readonly AuthoredSkillBundle[] = [
  TEST_TWO_SKILL_BUNDLE,
  TEST_SETUP_BUNDLE,
  ALPACA_THESIS_TRADING,
  KAGGLE_COMPETITION_BUNDLE,
  CODING_PR_LOOP_BUNDLE,
  LOCAL_COMMISSION_BUNDLE,
  LOCAL_CODE_REVIEW_BUNDLE,
  LOCAL_PUBLISH_BUNDLE,
  LOCAL_PR_SHEPHERD_BUNDLE,
  TICKER_DIGEST,
  WEB_RESEARCH_BRIEF,
  LITERATURE_SCAN,
  FILM_SHOT_BATCH,
  EVAL_SUITE_DESIGN,
];

/**
 * Ordered catalog of curated bundles, validated through `SkillBundleSchema`.
 * Visible entries appear in the Store UI; entries with `hidden: true` are
 * test fixtures only.
 */
export const SKILL_BUNDLE_CATALOG: readonly SkillBundle[] = RAW_BUNDLES.map((entry) => {
  const { revision: _revision, ...authored } = entry;
  const result = SkillBundleSchema.safeParse({
    ...authored,
    version: publishedBundleVersion(entry),
  });
  if (!result.success) {
    throw new Error(
      `Invalid bundle "${entry.bundleId}" in catalog: ${result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
});

const BUNDLE_BY_ID: Readonly<Record<string, SkillBundle>> = Object.freeze(
  SKILL_BUNDLE_CATALOG.reduce<Record<string, SkillBundle>>((acc, entry) => {
    if (acc[entry.bundleId]) {
      throw new Error(`Duplicate bundle id in catalog: ${entry.bundleId}`);
    }
    acc[entry.bundleId] = entry;
    return acc;
  }, {}),
);

// ============================================================================
// Lookup + list
// ============================================================================

/**
 * Fetch a bundle by id. Returns `null` for unknown ids.
 */
export function getSkillBundleEntry(bundleId: string): SkillBundle | null {
  return BUNDLE_BY_ID[bundleId] ?? null;
}

/**
 * List all bundles. Excludes hidden entries by default.
 */
export function listSkillBundles(opts?: { includeHidden?: boolean }): readonly SkillBundle[] {
  if (opts?.includeHidden) return SKILL_BUNDLE_CATALOG;
  return SKILL_BUNDLE_CATALOG.filter((b) => !b.hidden);
}

/**
 * Validate every `skillCatalogIds` entry resolves against the skill catalog.
 * Returns the list of missing ids; empty array = all resolved.
 *
 * Used at module-load time (see below) and by tests/tools to catch broken
 * bundles in CI before they ship. The registry is read-only at runtime,
 * so we want broken references to fail the build, not the install op.
 */
export function findUnresolvedSkillCatalogIds(bundle: SkillBundle): readonly string[] {
  return bundle.skillCatalogIds.filter((id) => getSkillCatalogEntry(id) === null);
}

// ============================================================================
// Build-time integrity check
// ============================================================================

// Run on module load: every visible bundle must resolve every skill it
// references. Hidden test fixtures are exempt (test code may stub the
// catalog). This catches typos and renames at build/import time rather
// than at install time.
for (const bundle of SKILL_BUNDLE_CATALOG) {
  if (bundle.hidden) continue;
  const missing = findUnresolvedSkillCatalogIds(bundle);
  if (missing.length > 0) {
    throw new Error(
      `Bundle "${bundle.bundleId}" references unknown skillCatalogIds: ${missing.join(', ')}`,
    );
  }
}
