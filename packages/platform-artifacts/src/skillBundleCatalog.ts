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

// ============================================================================
// kaggle-competition — Kaggle competition optimizer
// ============================================================================

const KAGGLE_API_TOKEN_CREDENTIAL_KEY = 'kaggle-api-token';

const KAGGLE_COMPETITION_BUNDLE: SkillBundleInput = {
  bundleId: 'kaggle-competition' as SkillBundleId,
  version: 6,
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
        // The executor follows the redirect (forwarding the Bearer, which GCS
        // ignores for a signed URL) and downloads the file in one call.
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

const CODING_PR_LOOP_BUNDLE: SkillBundleInput = {
  bundleId: 'coding-pr-loop' as SkillBundleId,
  version: 3,
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
// local-code-review — review committed changes in a connected repository
// ============================================================================

const LOCAL_CODE_REVIEW_BUNDLE: SkillBundleInput = {
  bundleId: 'local-code-review' as SkillBundleId,
  version: 5,
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
    'The review reads the connected folder at its last commit, so uncommitted work is invisible to it — ask for the work in progress to be committed, on a branch, before reviewing it.',
  ],
};

// ============================================================================
// local-publish — publish a patch to a branch and a pull request
// ============================================================================

const LOCAL_PUBLISH_BUNDLE: SkillBundleInput = {
  bundleId: 'local-publish' as SkillBundleId,
  version: 11,
  name: 'Local Publish',
  tagline:
    'Commit a patch onto a branch of a connected repository, clear the push, and open the pull request.',
  description: `Installs **Publish Local Changes** — the step after a commission: a patch becomes a commit on a branch of a repository connected as a folder — a new one, or the branch a fix was commissioned from, and then, once the push is cleared, a pushed branch and an open pull request.

**What it installs**:
- The **Publish Local Changes** skill — the patch is committed in a detached worktree, so the working tree is untouched: a fresh branch starts at the commission's base, and the branch a fix was commissioned from is appended to at its head; everything the push would add — the commit and any of the folder's own commits under it that \`origin\` does not have yet — is scanned for secrets, with the commits' headers and messages and the pull request's title and summary, and a finding stops the run with nothing pushed; the run then waits for the operator's approval — unless the folder's push approval says it need not ask — and only after that is that commit pushed to its branch on \`origin\` — refused, with nothing pushed, where \`origin\`'s base no longer holds what the run measured or \`origin\` pushes elsewhere than it fetches — and the pull request opened.

**After install**: connect the repository as a folder allowing pushes under a branch prefix, and bind the GitHub connector for the space. Then hand the skill a commission's \`patchRef\`, a branch name under that prefix and a title.

**When it asks before pushing**: the folder's push approval, set on the machine that holds it — \`always\` asks before every push, \`never\` pushes without asking, and \`unless-unreviewed\` has the publication run a Local Code Review of everything the push would add and push without asking only when that review returns \`approve\`. \`unless-unreviewed\` is the default. Every publication scans what the push would carry before it, whatever the posture, which is what lets a review stand in for the approval. Where the scan could not read a file whole — binary, a NUL byte, too large, a line too long, a Git LFS pointer — or a line that looks like a secret carries an \`aflow-scan: allow\` comment, no review runs and the run asks the operator under every posture, \`never\` included, naming each. Change it with \`aflow harness push-approval <folder> <always|never|unless-unreviewed>\`.`,
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
    "A commission's change is published by its `patchRef`, never its `patch` text: that copy is cut short on a large change, and a run's inputs are capped at 32 KB together. `patch` is for a small diff the operator hands over.",
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
const RAW_BUNDLES: readonly SkillBundleInput[] = [
  TEST_TWO_SKILL_BUNDLE,
  TEST_SETUP_BUNDLE,
  ALPACA_THESIS_TRADING,
  KAGGLE_COMPETITION_BUNDLE,
  CODING_PR_LOOP_BUNDLE,
  LOCAL_CODE_REVIEW_BUNDLE,
  LOCAL_PUBLISH_BUNDLE,
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
  const result = SkillBundleSchema.safeParse(entry);
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
