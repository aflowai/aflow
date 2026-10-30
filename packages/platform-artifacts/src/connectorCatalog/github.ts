import { type ConnectorCatalogEntry, JOB_LOG_TAIL_PRESET } from '@aflow/schemas';

const ownerParam = {
  name: 'owner',
  location: 'path' as const,
  required: true,
  description: 'The account owner of the repository (a user or organization login).',
  schema: { type: 'string' },
};

const repoParam = {
  name: 'repo',
  location: 'path' as const,
  required: true,
  description: 'The name of the repository, without the .git extension.',
  schema: { type: 'string' },
};

const pullNumberParam = {
  name: 'pull_number',
  location: 'path' as const,
  required: true,
  description: 'The number that identifies the pull request within the repository.',
  schema: { type: 'integer' },
};

const perPageParam = {
  name: 'per_page',
  location: 'query' as const,
  required: false,
  description: 'Results per page (max 100).',
  schema: { type: 'integer' },
};

const branchParam = {
  name: 'branch',
  location: 'path' as const,
  required: true,
  description: 'The name of the branch.',
  schema: { type: 'string' },
};

const runIdParam = {
  name: 'run_id',
  location: 'path' as const,
  required: true,
  description: 'The id of the GitHub Actions workflow run.',
  schema: { type: 'integer' },
};

export const GITHUB_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'github',
  version: 7,
  name: 'GitHub',
  tagline: 'Open pull requests, poll CI checks, read failing jobs, merge, and close PRs.',
  description:
    'GitHub REST API. Create, read and rewrite pull requests, poll commit check-runs for CI status, ' +
    "read a failing Actions run's jobs and the end of a job's log, re-run the jobs that failed, " +
    'read pull-request reviews and review comments, post and edit status/handoff comments, merge a ' +
    'pull request, and close one. Authenticated with a GitHub token sent as a bearer token.',
  tags: ['developer-tools', 'version-control', 'pull-requests', 'ci', 'github'],
  vendor: 'GitHub',
  category: 'developer-tools',
  honestyLabel: 'curated',
  authKind: 'bearer',
  setupNote:
    'Provide a GitHub token (a fine-grained personal access token or a GitHub App installation ' +
    'token) with repository, pull-request, checks and actions access. It is sent as ' +
    "Authorization: Bearer <token>, to api.github.com only: a job's log is served from a signed " +
    'URL on Azure blob storage, which is followed without the token.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'GitHub token',
      setupNote:
        'Fine-grained PAT or GitHub App installation token with repo/PR/checks scopes; sent as Authorization: Bearer.',
    },
  ],
  definition: {
    apiId: 'github',
    name: 'GitHub',
    description: 'GitHub REST API — pull requests, check-runs, reviews, comments, merge.',
    baseUrl: 'https://api.github.com',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/vnd.github+json' },
    // No host beyond api.github.com: a binding sends its token to every host
    // in its allowedHosts on a direct-URL call. The signed log URL
    // `getJobLogs` redirects to is that endpoint's `redirectHosts`, which no
    // binding ever carries.
    suggestedEgressPolicy: { allowedMethods: ['GET', 'POST', 'PUT', 'PATCH'] },
    tags: ['developer-tools', 'github'],
    endpoints: [
      {
        endpointId: 'createPullRequest',
        name: 'Create pull request',
        description: 'Open a pull request from a head branch into a base branch.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/repos/{owner}/{repo}/pulls',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The pull request to create.',
            schema: {
              type: 'object',
              required: ['title', 'head', 'base'],
              properties: {
                title: {
                  type: 'string',
                  description: 'The title of the pull request.',
                },
                head: {
                  type: 'string',
                  description:
                    'The name of the branch where your changes are implemented (e.g. "feature-x").',
                },
                base: {
                  type: 'string',
                  description: 'The branch you want the changes pulled into (e.g. "main").',
                },
                body: {
                  type: 'string',
                  description: 'The contents of the pull request (Markdown).',
                },
                draft: {
                  type: 'boolean',
                  description: 'Whether to open the pull request as a draft.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pull-requests'],
      },
      {
        endpointId: 'updatePullRequest',
        name: 'Update pull request',
        description:
          "Rewrite an open pull request's title or body — its description, where the branch " +
          'it carries has changed since it was written.',
        method: 'PATCH',
        writeRiskTier: 'low',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}',
        params: [
          ownerParam,
          repoParam,
          pullNumberParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The text to write. A field left out is left as it is.',
            schema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'The new title of the pull request.',
                },
                body: {
                  type: 'string',
                  description: 'The new contents of the pull request (Markdown).',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pull-requests'],
      },
      {
        endpointId: 'getIssueComment',
        name: 'Get issue comment',
        description:
          'One comment on an issue or pull request, by its id, wherever it sits in the conversation.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/issues/comments/{comment_id}',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'comment_id',
            location: 'path',
            required: true,
            description: 'The id of the comment.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['comments'],
      },
      {
        endpointId: 'getRepository',
        name: 'Get repository',
        description:
          'Fetch a repository the token can see. GitHub answers 404, not 403, for a private ' +
          'repository the token has no access to, so a 404 here means invisible as often as absent.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}',
        params: [ownerParam, repoParam],
        tags: ['repositories'],
      },
      {
        endpointId: 'compareCommits',
        name: 'Compare commits',
        description: 'Compare a base commit with a head commit to attest ancestry.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/compare/{base}...{head}',
        params: [
          ownerParam,
          repoParam,
          ...['base', 'head'].map((name) => ({
            name,
            location: 'path' as const,
            required: true,
            description: 'The commit SHA to compare.',
            schema: { type: 'string' },
          })),
        ],
        tags: ['repositories'],
      },
      {
        endpointId: 'getPullRequest',
        name: 'Get pull request',
        description: 'Fetch a single pull request by number, including its head SHA and state.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}',
        params: [ownerParam, repoParam, pullNumberParam],
        tags: ['pull-requests'],
      },
      {
        endpointId: 'listPullRequests',
        name: 'List pull requests',
        description:
          'List pull requests on a repo, filterable by state and head branch (head=owner:branch). ' +
          'Use it to find a PR by its branch — e.g. to recover the PR number when createPullRequest ' +
          'reports one already exists for the branch (HTTP 422), instead of guessing PR numbers.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/pulls',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'state',
            location: 'query',
            required: false,
            description: 'Filter by state: open | closed | all (default open).',
            schema: { type: 'string', enum: ['open', 'closed', 'all'] },
          },
          {
            name: 'head',
            location: 'query',
            required: false,
            description: 'Filter by head branch as "owner:branch" (e.g. munchist:agent/feature-x).',
            schema: { type: 'string' },
          },
          {
            name: 'base',
            location: 'query',
            required: false,
            description: 'Filter by base branch name.',
            schema: { type: 'string' },
          },
          {
            name: 'sort',
            location: 'query',
            required: false,
            description:
              'Order by: created | updated | popularity | long-running (default created).',
            schema: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'] },
          },
          {
            name: 'direction',
            location: 'query',
            required: false,
            description: 'asc | desc (default desc).',
            schema: { type: 'string', enum: ['asc', 'desc'] },
          },
          perPageParam,
        ],
        tags: ['pull-requests'],
      },
      {
        endpointId: 'listPullRequestFiles',
        name: 'List pull request files',
        description:
          'List the files changed in a pull request, each with its status and unified-diff patch — the input an adversarial reviewer reads.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/files',
        params: [
          ownerParam,
          repoParam,
          pullNumberParam,
          {
            name: 'per_page',
            location: 'query',
            required: false,
            description: 'Results per page (max 100). Raise it so a larger PR is reviewed whole.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['pull-requests', 'reviews'],
      },
      {
        endpointId: 'listCheckRuns',
        name: 'List check runs for a ref',
        description:
          'List the CI check-runs for a commit ref (poll a head SHA or branch for CI status).',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/commits/{ref}/check-runs',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'ref',
            location: 'path',
            required: true,
            description: 'The commit reference — a SHA, branch name, or tag.',
            schema: { type: 'string' },
          },
          {
            name: 'filter',
            location: 'query',
            required: false,
            description: 'latest (default): the newest run of each check; all: every attempt.',
            schema: { type: 'string', enum: ['latest', 'all'] },
          },
          perPageParam,
        ],
        tags: ['ci', 'checks'],
      },
      {
        endpointId: 'listWorkflowRunJobs',
        name: 'List jobs for a workflow run',
        description:
          "List the jobs of a GitHub Actions workflow run, each with its conclusion and steps — the failing jobs of a red check, by name. A check run's details URL names its run as /actions/runs/<run_id>.",
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
        params: [
          ownerParam,
          repoParam,
          runIdParam,
          {
            name: 'filter',
            location: 'query',
            required: false,
            description: 'latest (default): the jobs of the latest attempt; all: of every attempt.',
            schema: { type: 'string', enum: ['latest', 'all'] },
          },
          perPageParam,
        ],
        tags: ['ci', 'actions'],
      },
      {
        endpointId: 'getJobLogs',
        name: "Get a job's log",
        description:
          "The end of a GitHub Actions job's log: its last 300 lines, fewer where those pass 60 KB — where a failing test's assertion and a dependency audit's advisories are. Returned as { excerpt, lines, totalLines, bytes, truncated }. GitHub redirects to a signed URL on Azure blob storage, followed without the token.",
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'job_id',
            location: 'path',
            required: true,
            description: 'The id of the job.',
            schema: { type: 'integer' },
          },
        ],
        responseTransformPresetId: JOB_LOG_TAIL_PRESET,
        // Older runs' logs are served from actions.githubusercontent.com.
        redirectHosts: ['*.blob.core.windows.net', '*.actions.githubusercontent.com'],
        tags: ['ci', 'actions'],
      },
      {
        endpointId: 'reRunFailedJobs',
        name: 'Re-run the failed jobs of a workflow run',
        description:
          'Re-run every failed job of a GitHub Actions workflow run, and the jobs that depend on them, as a new attempt of the same run — for a failure that was the machine, not the change.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs',
        params: [ownerParam, repoParam, runIdParam],
        tags: ['ci', 'actions'],
      },
      {
        endpointId: 'listPullRequestReviews',
        name: 'List pull request reviews',
        description:
          'List the reviews submitted on a pull request, oldest first — thirty to a page unless per_page says otherwise.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        params: [
          ownerParam,
          repoParam,
          pullNumberParam,
          perPageParam,
          {
            name: 'page',
            location: 'query',
            required: false,
            description: 'Which page, from 1, oldest first.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['pull-requests', 'reviews'],
      },
      {
        endpointId: 'getBranch',
        name: 'Get branch',
        description:
          "Fetch a branch, its head commit and whether it is protected. A token that reads the repository sees the classic protection's required checks under protection.required_status_checks; the protection endpoint itself wants an administrator.",
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/branches/{branch}',
        params: [ownerParam, repoParam, branchParam],
        tags: ['repositories', 'branches'],
      },
      {
        endpointId: 'getBranchRules',
        name: 'Get rules for a branch',
        description:
          "Every active rule of the repository rulesets that apply to a branch, one entry per rule — the required_status_checks rules name the checks a merge into it requires. Ruleset rules only: the classic branch protection's are on getBranch.",
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/rules/branches/{branch}',
        params: [ownerParam, repoParam, branchParam, perPageParam],
        tags: ['repositories', 'branches'],
      },
      {
        endpointId: 'listReviewComments',
        name: 'List pull request review comments',
        description: 'List the review comments (inline code comments) on a pull request.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
        params: [ownerParam, repoParam, pullNumberParam],
        tags: ['pull-requests', 'comments', 'reviews'],
      },
      {
        endpointId: 'createReview',
        name: 'Create pull request review',
        description:
          'Submit a review on a pull request — an overall verdict (APPROVE / REQUEST_CHANGES / COMMENT) with a body ' +
          'and optional inline comments on changed lines. The reviewer→fixer interface: the structured verdict lands ' +
          'in the repo system, where the next fix cycle reads it.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        params: [
          ownerParam,
          repoParam,
          pullNumberParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The review to submit.',
            schema: {
              type: 'object',
              required: ['event'],
              properties: {
                event: {
                  type: 'string',
                  enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
                  description: 'The review action: APPROVE, REQUEST_CHANGES, or COMMENT.',
                },
                body: {
                  type: 'string',
                  description:
                    'The overall review body (Markdown). Required when event is REQUEST_CHANGES or COMMENT.',
                },
                comments: {
                  type: 'array',
                  description: 'Inline comments anchored to changed lines of the diff.',
                  items: {
                    type: 'object',
                    required: ['path', 'body'],
                    properties: {
                      path: {
                        type: 'string',
                        description: 'Repo-relative file path the comment is on.',
                      },
                      line: {
                        type: 'integer',
                        description: 'Line in the file’s diff the comment applies to.',
                      },
                      side: {
                        type: 'string',
                        enum: ['LEFT', 'RIGHT'],
                        description: 'Diff side; RIGHT (the new version) by default.',
                      },
                      body: { type: 'string', description: 'The comment text.' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pull-requests', 'reviews'],
      },
      {
        endpointId: 'listIssueComments',
        name: 'List issue comments',
        description:
          'List the conversation comments on an issue or pull request (a pull request is an issue for comments) — ' +
          'read back the durable handoff/status comments and any approval signal posted as a comment. ' +
          'Distinct from listReviewComments, which returns inline code-review comments anchored to diff lines.',
        method: 'GET',
        pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'issue_number',
            location: 'path',
            required: true,
            description: 'The number of the issue or pull request whose comments to list.',
            schema: { type: 'integer' },
          },
          perPageParam,
          {
            name: 'page',
            location: 'query',
            required: false,
            description:
              'Which page, from 1, oldest first: the last page — the comment count divided by per_page, rounded up — holds the newest.',
            schema: { type: 'integer' },
          },
        ],
        tags: ['pull-requests', 'comments'],
      },
      {
        endpointId: 'updateIssueComment',
        name: 'Update issue comment',
        description:
          'Rewrite a comment on an issue or pull request, by its id — the one handoff comment a pass keeps current.',
        method: 'PATCH',
        writeRiskTier: 'low',
        pathTemplate: '/repos/{owner}/{repo}/issues/comments/{comment_id}',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'comment_id',
            location: 'path',
            required: true,
            description: 'The id of the comment.',
            schema: { type: 'integer' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The new text of the comment.',
            schema: {
              type: 'object',
              required: ['body'],
              properties: {
                body: {
                  type: 'string',
                  description: 'The contents of the comment (Markdown).',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['comments'],
      },
      {
        endpointId: 'createIssueComment',
        name: 'Create issue comment',
        description:
          'Post a comment on an issue or pull request (a pull request is an issue for comments) — ' +
          'use for status or handoff comments.',
        method: 'POST',
        writeRiskTier: 'low',
        pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
        params: [
          ownerParam,
          repoParam,
          {
            name: 'issue_number',
            location: 'path',
            required: true,
            description: 'The number of the issue or pull request to comment on.',
            schema: { type: 'integer' },
          },
          {
            name: 'body',
            location: 'body',
            required: true,
            description: 'The comment to post.',
            schema: {
              type: 'object',
              required: ['body'],
              properties: {
                body: {
                  type: 'string',
                  description: 'The contents of the comment (Markdown).',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['comments'],
      },
      {
        endpointId: 'mergePullRequest',
        name: 'Merge pull request',
        description:
          'Merge a pull request, optionally choosing the merge method and commit message.',
        method: 'PUT',
        writeRiskTier: 'medium',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/merge',
        params: [
          ownerParam,
          repoParam,
          pullNumberParam,
          {
            name: 'body',
            location: 'body',
            required: false,
            description: 'Optional merge options.',
            schema: {
              type: 'object',
              properties: {
                commit_title: {
                  type: 'string',
                  description: 'Title for the automatic merge commit.',
                },
                commit_message: {
                  type: 'string',
                  description: 'Extra detail appended to the merge commit message.',
                },
                merge_method: {
                  type: 'string',
                  enum: ['squash', 'merge', 'rebase'],
                  description: 'The merge method to use.',
                },
                sha: {
                  type: 'string',
                  description:
                    "The head commit the merge is for. GitHub refuses the merge where the pull request's head is no longer this commit.",
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pull-requests', 'merge'],
      },
      {
        endpointId: 'closePullRequest',
        name: 'Close pull request',
        description: 'Close a pull request without merging it (sets state to "closed").',
        method: 'PATCH',
        writeRiskTier: 'medium',
        pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}',
        params: [
          ownerParam,
          repoParam,
          pullNumberParam,
          {
            name: 'body',
            location: 'body',
            required: true,
            description:
              'The state change — this endpoint is only ever used to close a pull request.',
            schema: {
              type: 'object',
              required: ['state'],
              properties: {
                state: {
                  type: 'string',
                  enum: ['closed'],
                  description:
                    'The new state of the pull request. Only "closed" is supported here.',
                },
              },
              additionalProperties: false,
            },
          },
        ],
        tags: ['pull-requests'],
      },
    ],
  },
};
