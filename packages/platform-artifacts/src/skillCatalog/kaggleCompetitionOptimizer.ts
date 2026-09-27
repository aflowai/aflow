import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import {
  KAGGLE_OPTIMIZER_EXECUTE_PROMPT,
  KAGGLE_OPTIMIZER_EXTRACT_LEARNINGS_PROMPT,
} from './kaggleCompetitionOptimizerProse.js';

const KAGGLE_PREPARE_PROMPT = `Ensure the competition's data files are present in the per-competition memory cache, ready for the modeling step to read.

Inputs (in your task context):
- \`competitionSlug\` — competition slug (e.g. "titanic").

Cache path (the exact memory prefix every file lives under): \`/workflows/kaggle-competition-optimizer/competitions/{competitionSlug}/data/\`

Canonical filenames (always exactly these three names, whatever the upstream names are):
- \`train.csv\` — the training data.
- \`test.csv\` — the test data.
- \`submission_template.csv\` — the submission template. Upstream competitions name it differently (\`sample_submission.csv\`, \`gender_submission.csv\`, etc.); it is ALWAYS cached under \`submission_template.csv\` so the modeling step knows exactly which file carries the required column layout.

What "present and correct" means:

1. Read the competition's data-file listing. Each entry carries a file name and its authoritative byte size (\`totalBytes\`).

2. Identify the three upstream files from the listing:
   - the file named exactly \`train.csv\`,
   - the file named exactly \`test.csv\`,
   - the submission template — the entry whose name contains "submission" (if several match, the smallest by \`totalBytes\`).

3. Size-validated cache check. For each canonical file, a cached copy counts as present ONLY when its cached byte size equals the upstream \`totalBytes\` for that file. Treat a file as missing when it is absent OR when its cached size does not match the upstream size — a size mismatch means a stale/partial/wrong file, so re-fetch it and note the mismatch in \`issues\`.

4. Fetch each missing file straight into the cache at its canonical path (\`train.csv\`, \`test.csv\`, and the template renamed to \`submission_template.csv\` regardless of its upstream name). Fetch through the bound Kaggle API (binding \`kaggle-default\`), endpoint \`download_competition_data_file\`, params \`{ competitionName: <competitionSlug>, fileName: <upstream file name> }\`, streaming the response body straight to the destination cache path. These files are large and belong in the cache, never in your turn — the bytes must land at the cache path, not be read back into your context. Fetch them ONE AT A TIME (serially), never several at once.

Supported competition shape:
- v1 supports FLAT CSV competitions: \`train.csv\`, \`test.csv\`, and one submission-template CSV must all be PRESENT in the listing. Auxiliary metadata files alongside them (descriptions, documentation, \`.txt\`/\`.md\` — e.g. \`data_description.txt\`) are expected and ignored — never grounds to call the layout unsupported. Unsupported means a required file is missing from the listing, or the data arrives as a zip/archive, sharded or multi-part data, or nested folders — do NOT partially prepare those. Record a clear diagnostic in \`issues\` naming the unsupported layout and leave \`ready\` false.

Failure handling:
- If an individual fetch fails, record what failed in \`issues\` and continue with the rest.
- \`train.csv\`, \`test.csv\` and \`submission_template.csv\` are the mandatory set. Set \`ready\` true ONLY when ALL THREE are present and size-correct in the cache; otherwise set \`ready\` false and record why in \`issues\`. The template carries the column layout every submission is built against, so modeling cannot proceed without it. The modeling step will not run unless \`ready\` is true.

Output:
{
  dataRootPath: string,            // the resolved cache path
  filesAvailable: string[],        // canonical names present and size-correct, a subset of ["train.csv","test.csv","submission_template.csv"]
  submissionTemplateFile: string,  // "submission_template.csv" (the canonical template name)
  ready: boolean,                  // true only when ALL THREE canonical files are present and size-correct
  issues: string[]
}`;

const KAGGLE_COMPETITION_OPTIMIZER: SkillCatalogEntry = {
  catalogId: 'kaggle-competition-optimizer',
  version: 4,
  name: 'Kaggle Competition Optimizer',
  tagline: 'Iterate toward a target leaderboard score on a Kaggle competition.',
  description: `Iterative optimization skill for Kaggle competitions. Each invocation runs one attempt: gather competition context, propose a strategy informed by prior runs' learnings, implement and validate in a sandbox, optionally submit, observe the leaderboard score, and extract structured learnings for the next iteration.

**Campaign-driven**: the per-competition config (slug, metric, direction, target leaderboard score) is collected once into a campaign. Each iteration runs against that campaign — no per-run inputs to re-supply. Run a maximize competition (e.g. Titanic accuracy) and a minimize competition (e.g. House Prices RMSE) as separate campaigns on the same installed skill, with disjoint ledgers and the correct optimization direction each.

**Loop driver**: the Helmsman calls this workflow again after each run, deciding whether to iterate based on the outcome and your direction. Each submission is approval-gated — every submit asks for your confirmation before consuming Kaggle daily quota.

**Tabular competitions only** for v1 (regression / binary or multi-class classification on CSV data). GPU / vision / NLP / audio competitions need a separate runtime (deferred).

**Prerequisites**: a Kaggle API token (a \`KGAT_…\` token), configured once via the Kaggle API integration after bundle install; and you must JOIN each competition (accept its rules) on kaggle.com before submitting.`,
  tags: ['kaggle', 'ml', 'optimization', 'competitions'],
  bundle: {
    workflow: {
      slug: 'kaggle-competition-optimizer',
      name: 'Kaggle Competition Optimizer',
      description:
        'Iterate toward a target leaderboard score on a Kaggle competition. Each run = one attempt; Helmsman drives the iteration loop.',
      goal: 'Reach the campaign leaderboard target via iterative strategy proposals, sandbox-validated implementations, approval-gated submissions, observed leaderboard scores, and structured learnings recorded to the ledger after each run.',
      mode: 'optimization' as const,
      outcomes: [
        {
          id: 'lb-target',
          name: 'Leaderboard target',
          // operator + target resolve from the campaign config at read, so this
          // one outcome scores `gte targetScore` for a maximize campaign and
          // `lte targetScore` for a minimize campaign.
          evaluator: {
            type: 'threshold' as const,
            metric: 'lbValue',
            operator: {
              $campaign: 'metricDirection',
              map: { maximize: 'gte', minimize: 'lte' },
            },
            target: { $campaign: 'targetScore' },
          },
        },
      ],
      tasks: [
        {
          taskId: 'prepare',
          name: 'Prepare',
          goal: KAGGLE_PREPARE_PROMPT,
          type: 'agent' as const,
          inputBindings: {
            competitionSlug: { kind: 'campaign_input' as const, path: 'competitionSlug' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // api.http.download (destination-mandated) is the only byte-fetch
              // tool granted — a large body can only stream to the cache path,
              // never inline into the turn. The listing tool stays for the
              // small-JSON file list; the raw download endpoint is NOT surfaced
              // as a virtual tool (it would lower to an inline api.http.call).
              operations: ['memory.store.get', 'api.http.download'],
              integrations: [
                {
                  capabilityId: 'kaggle-default',
                  binding: { kind: 'binding' as const, bindingId: 'kaggle-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'kaggle',
                  toolNames: [{ toolName: 'list_competition_data_files' }],
                  allTools: false,
                },
              ],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: [
                'dataRootPath',
                'filesAvailable',
                'submissionTemplateFile',
                'ready',
                'issues',
              ],
              additionalProperties: false,
              properties: {
                dataRootPath: { type: 'string' },
                filesAvailable: { type: 'array', items: { type: 'string' } },
                submissionTemplateFile: { type: 'string' },
                ready: {
                  type: 'boolean',
                  description:
                    'True only when train.csv, test.csv and submission_template.csv are all present and size-correct in the cache. The modeling step is gated on this — it does not run when ready is false.',
                },
                issues: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },

        {
          taskId: 'execute',
          name: 'Execute',
          goal: KAGGLE_OPTIMIZER_EXECUTE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['prepare'],
          // Structural missing-file gate: never run the modeling step on missing
          // data. `ready` is true only when train.csv + test.csv are both cached.
          when: {
            expression: 'tasks.prepare.output.ready == true',
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            competitionSlug: { kind: 'campaign_input' as const, path: 'competitionSlug' },
            metricName: { kind: 'campaign_input' as const, path: 'metricName' },
            metricDirection: { kind: 'campaign_input' as const, path: 'metricDirection' },
            dataRootPath: {
              kind: 'task_output' as const,
              taskId: 'prepare',
              path: 'dataRootPath',
            },
            submissionTemplateFile: {
              kind: 'task_output' as const,
              taskId: 'prepare',
              path: 'submissionTemplateFile',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              operations: ['compute.sandbox.exec', 'memory.store.get', 'memory.store.put'],
              integrations: [],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['approachSummary', 'validationScore', 'submit', 'decisionRationale'],
              additionalProperties: false,
              properties: {
                approachSummary: { type: 'string', maxLength: 1500 },
                validationScore: { type: ['number', 'null'] },
                submit: { type: 'boolean' },
                decisionRationale: { type: 'string', maxLength: 1500 },
                submissionPayload: {
                  type: ['object', 'null'],
                  required: ['filePath', 'message'],
                  additionalProperties: false,
                  properties: {
                    filePath: {
                      type: 'string',
                      description:
                        'Memory path of the submission.csv your sandbox wrote — the path you declared in workspace.outputs (e.g. "<dataRootPath>submission.csv").',
                    },
                    message: { type: 'string', maxLength: 500 },
                  },
                },
              },
            },
          },
          // Promoted so a non-submitting iteration still produces a run output.
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'approachSummary', toState: 'approachSummary' },
            { kind: 'output_path' as const, path: 'validationScore', toState: 'validationScore' },
          ],
        },

        {
          taskId: 'approve-submit',
          name: 'Approve Kaggle submission',
          goal: 'Operator approves the prepared Kaggle submission before it consumes daily quota and lands on the public leaderboard.',
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['execute'],
          when: {
            expression: 'tasks.execute.output.submit == true',
            onMissingRef: 'skip' as const,
          },
          pauseInstruction:
            'Review the submission below. Approve to send it to Kaggle, or reject to skip this iteration (learnings are still recorded).',
          // The downstream submit tasks read approve-submit.approvedCall.input.*,
          // so what the operator sees here is exactly what gets uploaded.
          actionPreview: {
            op: 'kaggle.submit',
            inputBindings: {
              competitionName: { kind: 'campaign_input' as const, path: 'competitionSlug' },
              message: {
                kind: 'task_output' as const,
                taskId: 'execute',
                path: 'submissionPayload.message',
              },
              filePath: {
                kind: 'task_output' as const,
                taskId: 'execute',
                path: 'submissionPayload.filePath',
              },
            },
          },
        },

        // blobs/upload needs the exact content length and the PUT needs the same
        // byte count for Content-Range; both come from one stat read.
        {
          taskId: 'submission-stat',
          name: 'Stat submission file',
          goal: 'Read the byte length of the approved submission file (memory.store.get stat view).',
          type: 'operation' as const,
          operation: 'memory.store.get',
          dependsOn: ['approve-submit'],
          retryability: 'safe' as const,
          when: {
            expression: 'tasks.execute.output.submit == true',
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            filePath: {
              kind: 'task_output' as const,
              taskId: 'approve-submit',
              path: 'approvedCall.input.filePath',
            },
          },
          inputTemplate: {
            target: { path: { $bind: 'filePath' } },
            view: 'stat',
          },
        },

        {
          taskId: 'submit-request-upload',
          name: 'Request submission upload',
          goal: 'Request a resumable upload slot for the submission file (returns a Google upload URL + a blob token).',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['submission-stat'],
          retryability: 'safe' as const,
          when: {
            expression: 'tasks.execute.output.submit == true',
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            sizeBytes: {
              kind: 'task_output' as const,
              taskId: 'submission-stat',
              path: 'stat.sizeBytes',
            },
          },
          inputTemplate: {
            apiId: 'kaggle',
            endpointId: 'request_submission_upload',
            params: {
              body: {
                type: 'inbox',
                name: 'submission.csv',
                contentLength: { $bind: 'sizeBytes' },
                lastModifiedEpochSeconds: 0,
              },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            createUrl: { path: 'data.createUrl', onMissing: 'error' as const },
            token: { path: 'data.token', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['createUrl', 'token'],
              additionalProperties: false,
              properties: {
                createUrl: { type: 'string', minLength: 1, maxLength: 2048, format: 'uri' },
                token: { type: 'string', minLength: 1 },
              },
            },
          },
        },

        {
          taskId: 'submit-put-bytes',
          name: 'Upload submission bytes',
          goal: 'PUT the submission file bytes to the Google resumable-upload URL.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['submit-request-upload'],
          retryability: 'safe' as const,
          when: {
            expression: 'tasks.execute.output.submit == true',
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            createUrl: {
              kind: 'task_output' as const,
              taskId: 'submit-request-upload',
              path: 'createUrl',
            },
            filePath: {
              kind: 'task_output' as const,
              taskId: 'approve-submit',
              path: 'approvedCall.input.filePath',
            },
          },
          inputTemplate: {
            apiId: 'kaggle-data-fetch',
            bindingId: 'kaggle-data-fetch-default',
            url: { $bind: 'createUrl' },
            method: 'PUT',
            // Google's resumable upload requires Content-Range on the final
            // chunk; emitContentRange derives it from the resolved body length.
            bodySource: { fromPath: { $bind: 'filePath' }, emitContentRange: true },
            headers: { 'Content-Type': 'text/csv' },
            response: { format: 'text' },
          },
          // A failed PUT leaves the blob token with no bytes behind it; gate on
          // 2xx so submit-finalize can't run against an empty upload.
          outputContract: {
            schema: {
              type: 'object',
              required: ['statusCode'],
              properties: {
                statusCode: { type: 'number', minimum: 200, maximum: 299 },
              },
            },
          },
        },

        // Only quota-consuming step. unsafe: a timed-out finalize may have
        // landed, so a retry must be operator-confirmed, not blind.
        {
          taskId: 'submit-finalize',
          name: 'Finalize submission',
          goal: 'Finalize the Kaggle submission from the uploaded blob token. Consumes daily quota.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['submit-put-bytes'],
          retryability: 'unsafe' as const,
          maxAttempts: 3,
          when: {
            expression: 'tasks.execute.output.submit == true',
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            competitionName: {
              kind: 'task_output' as const,
              taskId: 'approve-submit',
              path: 'approvedCall.input.competitionName',
            },
            token: {
              kind: 'task_output' as const,
              taskId: 'submit-request-upload',
              path: 'token',
            },
            message: {
              kind: 'task_output' as const,
              taskId: 'approve-submit',
              path: 'approvedCall.input.message',
            },
          },
          inputTemplate: {
            apiId: 'kaggle',
            endpointId: 'submit_to_competition',
            params: {
              competitionName: { $bind: 'competitionName' },
              body: {
                blobFileTokens: [{ $bind: 'token' }],
                submissionDescription: { $bind: 'message' },
              },
            },
            response: { format: 'json' },
          },
          // The submit response carries a numeric `ref` only when a submission
          // was actually minted; requiring it fails the task otherwise, so no
          // phantom-success run flows to extract/record.
          outputProjection: {
            submissionId: { path: 'data.ref', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['submissionId'],
              additionalProperties: false,
              properties: {
                submissionId: { type: 'number' },
              },
            },
          },
        },

        // Submissions list is most-recent-first; [0] is the submission just
        // finalized. Kaggle exposes no get-submission-by-id endpoint, and the
        // projection dialect cannot filter the array by ref, so this reads [0].
        // Valid because a campaign's runs are sequential and the runner submits
        // then immediately polls; a concurrent/manual submission landing in that
        // window is the known exposure (acceptable for single-operator use).
        {
          taskId: 'poll-lb',
          name: 'Poll leaderboard score',
          goal: 'Poll the Kaggle submission status until scoring completes (or errors), then project the public leaderboard score.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['submit-finalize'],
          retryability: 'safe' as const,
          when: {
            expression: 'tasks.execute.output.submit == true',
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            competitionSlug: { kind: 'campaign_input' as const, path: 'competitionSlug' },
          },
          inputTemplate: {
            apiId: 'kaggle',
            endpointId: 'list_competition_submissions',
            params: { competitionName: { $bind: 'competitionSlug' } },
            response: { format: 'json' },
          },
          poll: {
            intervalMs: 60000,
            maxCycles: 5,
            until: {
              anyOf: ["output.data[0].status == 'complete'", "output.data[0].status == 'error'"],
            },
            onExhausted: 'complete' as const,
          },
          // publicScore is "" until scored and on error → parse 'number' → NaN →
          // null. Without onMissing 'null' it would coerce to 0 and falsely
          // satisfy a minimize target.
          outputProjection: {
            lbValue: {
              path: 'data[0].publicScore',
              parse: ['number'] as const,
              onMissing: 'null' as const,
            },
            lbStatus: { path: 'data[0].status', onMissing: 'error' as const },
            submissionId: { path: 'data[0].ref', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['lbValue', 'lbStatus', 'submissionId'],
              additionalProperties: false,
              properties: {
                lbValue: { type: ['number', 'null'] },
                lbStatus: { type: 'string' },
                submissionId: { type: 'number' },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'lbValue', toState: 'lbValue' },
            { kind: 'output_path' as const, path: 'lbStatus', toState: 'lbStatus' },
          ],
        },

        // Runs in both branches. On a skipped submit chain the lb bindings
        // resolve absent and the skip rationale is the signal.
        {
          taskId: 'extract-learnings',
          name: 'Extract Learnings',
          goal: KAGGLE_OPTIMIZER_EXTRACT_LEARNINGS_PROMPT,
          type: 'agent' as const,
          dependsOn: ['poll-lb'],
          inputBindings: {
            approachSummary: {
              kind: 'task_output' as const,
              taskId: 'execute',
              path: 'approachSummary',
            },
            validationScore: {
              kind: 'task_output' as const,
              taskId: 'execute',
              path: 'validationScore',
            },
            submit: { kind: 'task_output' as const, taskId: 'execute', path: 'submit' },
            decisionRationale: {
              kind: 'task_output' as const,
              taskId: 'execute',
              path: 'decisionRationale',
            },
            lbValue: { kind: 'task_output' as const, taskId: 'poll-lb', path: 'lbValue' },
            lbStatus: { kind: 'task_output' as const, taskId: 'poll-lb', path: 'lbStatus' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              operations: [],
              integrations: [],
            },
          },
          // The `learnings` output shape is derived from record-learnings'
          // workflow.learn input; only `runSummary` is author-declared.
          outputContract: {
            schema: {
              type: 'object',
              required: ['runSummary'],
              additionalProperties: false,
              properties: {
                runSummary: { type: 'string', maxLength: 500 },
              },
            },
          },
        },

        {
          taskId: 'record-learnings',
          name: 'Record Learnings',
          goal: 'Persist the extracted learnings to the workflow ledger via workflow.learn. Next iteration reads them automatically.',
          type: 'operation' as const,
          operation: 'workflow.learn',
          dependsOn: ['extract-learnings'],
          inputBindings: {
            learnings: {
              kind: 'task_output' as const,
              taskId: 'extract-learnings',
              path: 'learnings',
            },
          },
        },
      ],
      stateVariables: [
        {
          variableId: 'lbValue',
          name: 'Leaderboard score',
          description: 'Kaggle public leaderboard score for this run’s submission.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'lbStatus',
          name: 'Leaderboard status',
          description:
            'Raw Kaggle scoring status of the submission (complete / pending / error / …).',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'approachSummary',
          name: 'Approach summary',
          description: 'One-paragraph summary of the strategy attempted this run.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'validationScore',
          name: 'Validation score',
          description: 'Local cross-validation score before submission.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'lbValue',
        guidance:
          'Compare lbValue against the campaign target and the campaign best. If the target is not met and run budget remains, summarize the approach + learnings for the operator and propose the next iteration (workflow.run.start). If lbStatus is not "complete", the submission was not scored — report that instead of a score.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'kaggle-competition-optimizer',
      name: 'Kaggle Competition Optimizer',
      // direction resolves from the campaign at read, so one skill serves both
      // maximize and minimize campaigns with the correct identity + trajectory.
      goal: {
        type: 'numeric' as const,
        metricKey: 'lbValue',
        direction: { $campaign: 'metricDirection' },
      },
      mode: 'optimization' as const,
      // competitionSlug is the campaign identity — a different slug is a
      // different campaign.
      campaign: {
        fields: {
          competitionSlug: {
            schema: {
              type: 'string',
              minLength: 1,
              pattern: '^[a-z0-9][a-z0-9-]*$',
            },
            identity: true,
            label: 'Competition slug',
            description:
              'Kaggle competition slug as it appears in the competition URL (e.g. "titanic"). Identifies the campaign.',
          },
          metricName: {
            schema: { type: 'string', minLength: 1 },
            label: 'Metric name',
            description:
              "Evaluation metric name, display/context only (e.g. 'Categorization Accuracy', 'RMSE'). The authoritative score is Kaggle's leaderboard value.",
          },
          metricDirection: {
            schema: { type: 'string', enum: ['minimize', 'maximize'] },
            label: 'Metric direction',
            description:
              'Whether a lower (minimize, e.g. RMSE) or higher (maximize, e.g. accuracy) leaderboard score is better.',
          },
          targetScore: {
            schema: { type: 'number' },
            label: 'Target leaderboard score',
            description: 'The public leaderboard score that ends the campaign as goal-met.',
          },
        },
      },
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        execute: [
          {
            name: 'validation-produced',
            type: 'contains' as const,
            inField: 'validationScore',
            pattern: '^-?\\d+(\\.\\d+)?$',
          },
        ],
        'poll-lb': [
          {
            name: 'lb-target-met',
            type: 'threshold' as const,
            metric: 'lbValue',
            operator: {
              $campaign: 'metricDirection',
              map: { maximize: 'gte', minimize: 'lte' },
            },
            target: { $campaign: 'targetScore' },
          },
        ],
      },
      trajectoryCriteria: [],
      weights: { goal: 0, task: 1.0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    activation: {
      triggerPatterns: [
        'kaggle competition',
        'kaggle optimizer',
        'optimize kaggle',
        'climb kaggle leaderboard',
        'submit to kaggle',
        'iterate on kaggle',
      ],
      activationHint:
        'Iterative Kaggle competition work toward a target leaderboard score. Start a campaign for the competition (the contract collects competition slug, metric name, direction, target score), then iterate — each submission is approval-gated.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The real Kaggle optimization skill: 100% api.http.call over the Kaggle REST API. The submit chain is four deterministic operation tasks and leaderboard polling is a single poll op task — zero agents between approval and the recorded score. Per-competition config is a campaign contract; goal direction + target are $campaign refs, so one skill serves maximize and minimize campaigns with disjoint ledgers. Tabular competitions only for v1.',
  },
};

export { KAGGLE_COMPETITION_OPTIMIZER };
