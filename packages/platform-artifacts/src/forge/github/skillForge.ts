/**
 * GitHub's provider of the forge vocabulary for the loop's skills (Plan 340
 * D2): each act as the GitHub REST call it is, through the `github` API
 * definition (D4), with the response transform that shapes GitHub's answer
 * into the vocabulary's record. The calls are the ones Local Publish and the
 * Local PR Shepherd made before the seam, unchanged.
 */
import {
  GITHUB_API_ID,
  PULL_REQUEST_REVIEWS_PER_PAGE,
  SHEPHERD_RESPONSE_PRESETS,
} from '@aflow/schemas';
import type { ForgeCall, SkillForge, TemplateValue } from '../vocabulary.js';

/**
 * GitHub's answer, with 405, to a merge whose base branch moved between the
 * pull request's read and the merge — another pull request merged first. The
 * wording is matched exactly: a 405 can also mean a conflict or a rule the
 * base requires, which no re-attempt clears, and wording GitHub changes falls
 * back to the ordinary refusal rather than a re-attempt that repeats forever.
 */
export const BASE_MOVED_MESSAGE = 'Base branch was modified. Review and try the merge again.';

/** GitHub's rule for an owner: letters, digits and single hyphens between them, at most 39. */
const OWNER_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$';

/**
 * GitHub's rule for a repository: letters, digits, `.`, `_` and `-`, at most
 * 100. `.` and `..` are refused because they collapse `/repos/{owner}/{repo}`
 * onto another endpoint.
 */
const REPO_PATTERN = '^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$';

/** The page size GitHub lists in: its largest. */
const PER_PAGE = 100;

function call(endpointId: string, params: Record<string, unknown>, transformPresetId?: unknown) {
  return {
    apiId: GITHUB_API_ID,
    endpointId,
    params,
    response: {
      format: 'json',
      ...(transformPresetId !== undefined ? { transformPresetId } : {}),
    },
  } satisfies ForgeCall;
}

function asText(value: TemplateValue) {
  return { $text: [value] };
}

/** A part of the transform's argument, or nothing where any of its parts is absent. */
function optionalPart(...parts: unknown[]) {
  return { $firstOf: [{ $concat: parts }, ''] };
}

/** GitHub filters a listing on the head only in its `owner:branch` form. */
function headOf(owner: TemplateValue, branch: TemplateValue) {
  return { $concat: [owner, ':', branch] };
}

/**
 * `loop_handoff:<author>:<number>` — the record trusted only from the pinned
 * author, and only on this pull request. With no pin there is no author, and
 * nothing is trusted.
 */
function handoffPreset(author: TemplateValue, number: TemplateValue) {
  return [
    `${SHEPHERD_RESPONSE_PRESETS.handoff}:`,
    { $firstOf: [asText(author), ''] },
    ':',
    asText(number),
  ];
}

export const GITHUB_SKILL_FORGE: SkillForge = {
  provider: 'github',

  capabilityHints: {
    publish: {
      apiId: GITHUB_API_ID,
      description:
        "GitHub REST API — read the repository before the push, then find the open pull request for the pushed branch and rewrite its description, or open one where there is none; where an override names the hands-off label or a shepherd rule, read that pull request's labels and the shepherd's pinned handoff comment to verify it.",
      requiredEndpoints: [
        'getRepository',
        'listPullRequests',
        'getIssueComment',
        'createPullRequest',
        'updatePullRequest',
      ],
      authKind: 'bearer',
      setupNote:
        'Bind the GitHub connector for the space (a fine-grained personal access token or a GitHub App installation token with repository and pull-request access) before the first run. Sent as Authorization: Bearer.',
    },
    shepherd: {
      apiId: GITHUB_API_ID,
      description:
        "GitHub REST API — list and read the loop's pull requests, their check runs, reviews and comments, the base branch's required checks, a failing run's jobs and the end of a job's log, re-run failed jobs, write the handoff comment, and merge where the folder's posture allows.",
      requiredEndpoints: [
        'listPullRequests',
        'getPullRequest',
        'listCheckRuns',
        'listIssueComments',
        'getIssueComment',
        'listWorkflowRunJobs',
        'getJobLogs',
        'reRunFailedJobs',
        'createIssueComment',
        'updateIssueComment',
        'getBranchRules',
        'getBranch',
        'listPullRequestReviews',
        'mergePullRequest',
      ],
      authKind: 'bearer',
      setupNote:
        "Bind the GitHub connector for the space with a token that reads pull requests, checks, branches and Actions and writes comments — and merges pull requests, where a folder's merge posture is `when-green`. A job's log is served from a signed URL on Azure blob storage, which `getJobLogs` follows without the token; the binding allows no host but api.github.com.",
    },
  },

  coordinate: {
    owner: {
      type: 'string',
      minLength: 1,
      maxLength: 39,
      pattern: OWNER_PATTERN,
      description:
        'The owner name alone — `aflowai` for github.com/aflowai/aflow — not a URL or `owner/repo`. Letters, digits and single hyphens between them, 1 to 39 characters: no dot, and no hyphen at the start, at the end or twice in a row.',
    },
    repo: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: REPO_PATTERN,
      description:
        'The repository name alone — `aflow` for github.com/aflowai/aflow — not a URL or `owner/repo`. Letters, digits, `.`, `_` and `-`, 1 to 100 characters, and neither `.` nor `..`.',
    },
  },

  readRepository: ({ owner, repo }) => call('getRepository', { owner, repo }),
  repositoryProjection: {
    repository: { path: 'data.full_name', onMissing: 'error' },
  },

  listChangeRequests: {
    loop: ({ owner, repo, prefix, lastTended }) =>
      call(
        'listPullRequests',
        { owner, repo, state: 'open', sort: 'updated', direction: 'desc', per_page: PER_PAGE },
        {
          $concat: [
            `${SHEPHERD_RESPONSE_PRESETS.pullRequests}:`,
            prefix,
            optionalPart(':', asText(lastTended)),
          ],
        },
      ),
    ofBranch: ({ owner, repo, branch, base, prefix }) =>
      call(
        'listPullRequests',
        { owner, repo, head: headOf(owner, branch), base, state: 'open' },
        prefix === undefined
          ? undefined
          : { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequests}:`, prefix] },
      ),
  },
  branchListingProjection: {
    prNumber: { path: 'data[0].number', onMissing: 'null' },
    prUrl: { path: 'data[0].html_url', onMissing: 'null' },
  },

  readChangeRequest: ({ owner, repo, number, prefix }) =>
    call(
      'getPullRequest',
      { owner, repo, pull_number: number },
      { $concat: [`${SHEPHERD_RESPONSE_PRESETS.pullRequest}:`, prefix] },
    ),
  readChecks: ({ owner, repo, head, required }) =>
    call(
      'listCheckRuns',
      { owner, repo, ref: head, per_page: PER_PAGE },
      {
        $firstOf: [
          { $concat: [`${SHEPHERD_RESPONSE_PRESETS.checkRuns}:`, required] },
          SHEPHERD_RESPONSE_PRESETS.checkRuns,
        ],
      },
    ),
  readBranchHead: ({ owner, repo, branch }) => call('getBranch', { owner, repo, branch }),
  branchHeadProjection: {
    statusCode: { path: 'statusCode', onMissing: 'error' },
    sha: { path: 'data.commit.sha', onMissing: 'null' },
  },
  readRequiredRules: ({ owner, repo, branch }) =>
    call(
      'getBranchRules',
      { owner, repo, branch, per_page: PER_PAGE },
      SHEPHERD_RESPONSE_PRESETS.requiredRules,
    ),
  readRequiredChecks: ({ owner, repo, branch, rules }) =>
    call(
      'getBranch',
      { owner, repo, branch },
      { $concat: [`${SHEPHERD_RESPONSE_PRESETS.requiredProtection}:`, rules] },
    ),
  readReviews: ({ owner, repo, number }) =>
    call(
      'listPullRequestReviews',
      { owner, repo, pull_number: number, per_page: PULL_REQUEST_REVIEWS_PER_PAGE, page: 1 },
      SHEPHERD_RESPONSE_PRESETS.reviews,
    ),
  readFailingJobs: ({ owner, repo, run }) =>
    call(
      'listWorkflowRunJobs',
      { owner, repo, run_id: run, per_page: PER_PAGE },
      SHEPHERD_RESPONSE_PRESETS.failingJobs,
    ),
  readJobLog: ({ owner, repo, job }) => call('getJobLogs', { owner, repo, job_id: job }),
  rerunFailedJobs: ({ owner, repo, run }) => call('reRunFailedJobs', { owner, repo, run_id: run }),

  openChangeRequest: ({ owner, repo, branch, base, title, body }) =>
    call('createPullRequest', {
      owner,
      repo,
      body: { title, head: branch, base, body, draft: false },
    }),
  openedProjection: {
    prNumber: { path: 'data.number', onMissing: 'error' },
    prUrl: { path: 'data.html_url', onMissing: 'error' },
  },
  updateChangeRequest: ({ owner, repo, number, title, body }) =>
    call('updatePullRequest', { owner, repo, pull_number: number, body: { title, body } }),
  updatedProjection: {
    prNumber: { path: 'data.number', onMissing: 'error' },
  },

  mergeChangeRequest: ({ owner, repo, number, head }) =>
    call('mergePullRequest', {
      owner,
      repo,
      pull_number: number,
      body: { merge_method: 'squash', sha: head },
    }),
  merge: {
    merged: (ref) => `${ref}.statusCode == 200`,
    notMerged: (ref) => `${ref}.statusCode != 200`,
    refused: (ref) => `${ref}.statusCode == 405`,
    otherThanBaseMoved: (ref) => [
      `${ref}.statusCode != 405`,
      `${ref}.data.message != '${BASE_MOVED_MESSAGE}'`,
    ],
    commitPath: 'data.sha',
  },
  refusalMessagePath: 'data.message',

  readHandoff: ({ owner, repo, comment, author, number }) =>
    call(
      'getIssueComment',
      { owner, repo, comment_id: comment },
      { $concat: handoffPreset(author, number) },
    ),
  findHandoff: ({ owner, repo, number, page, author, carried }) =>
    call(
      'listIssueComments',
      { owner, repo, issue_number: number, per_page: PER_PAGE, page },
      {
        $concat: [
          ...handoffPreset(author, number),
          optionalPart(':', asText(carried.attempts), ':', {
            $firstOf: [asText(carried.checkRun), ''],
          }),
        ],
      },
    ),
  postHandoff: ({ owner, repo, number, body }) =>
    call('createIssueComment', { owner, repo, issue_number: number, body: { body } }),
  updateHandoff: ({ owner, repo, comment, body }) =>
    call('updateIssueComment', { owner, repo, comment_id: comment, body: { body } }),
  handoffWritten: { idPath: 'data.id', authorPath: 'data.user.login' },
};
