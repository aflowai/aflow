import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  computeRejectedApprovalSkipSet,
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateWhenExpression,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
import {
  SkillComposeBundleSchema,
  getOperation,
  toJsonSchemaSync,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';

const KAGGLE_SLUG = 'kaggle-competition-optimizer';

describe('KAGGLE_COMPETITION_OPTIMIZER', () => {
  const entry = getSkillCatalogEntry(KAGGLE_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${KAGGLE_SLUG}" not found`);
  }
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id);

  it('parses as a SkillComposeBundle workflow', () => {
    const parsed = SkillComposeBundleSchema.safeParse(entry.bundle);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes validateWorkflowGraph after Phase D materialization', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const errors = validateWorkflowGraph(tasks, wf.stateVariables);
    expect(errors).toEqual([]);
  });

  it('Phase D derives extract-learnings.learnings from workflow.learn', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const extract = tasks.find((t) => t.taskId === 'extract-learnings');
    const learnings = (extract?.outputContract?.schema as { properties: { learnings: unknown } })
      .properties.learnings;
    const opLearnings = (
      toJsonSchemaSync(getOperation('workflow.learn')!.inputZod) as {
        properties: { learnings: unknown };
      }
    ).properties.learnings;
    expect(learnings).toEqual(opLearnings);
  });

  it('has the expected 10-task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set([
        'prepare',
        'execute',
        'approve-submit',
        'submission-stat',
        'submit-request-upload',
        'submit-put-bytes',
        'submit-finalize',
        'poll-lb',
        'extract-learnings',
        'record-learnings',
      ]),
    );
  });

  it('the submit + poll chain is deterministic operation tasks (no agents)', () => {
    for (const id of [
      'submission-stat',
      'submit-request-upload',
      'submit-put-bytes',
      'submit-finalize',
      'poll-lb',
    ]) {
      expect(task(id)?.type, id).toBe('operation');
    }
  });

  it('every submit-chain task gates on execute.submit == true', () => {
    const expression = 'tasks.execute.output.submit == true';
    for (const id of [
      'approve-submit',
      'submission-stat',
      'submit-request-upload',
      'submit-put-bytes',
      'submit-finalize',
      'poll-lb',
    ]) {
      expect(task(id)?.when?.expression, id).toBe(expression);
    }
  });

  it('when clauses use supported expression syntax', () => {
    const whenTasks = wf.tasks.filter((t) => t.when?.expression);
    expect(whenTasks.length).toBeGreaterThan(0);
    for (const t of whenTasks) {
      expect(validateWhenExpression(t.when!.expression), `task ${t.taskId}`).toBeNull();
    }
  });

  it('only submit-finalize carries the unsafe-retry gate (the sole quota-consuming step)', () => {
    expect(task('submit-finalize')?.retryability).toBe('unsafe');
    expect(task('submit-finalize')?.maxAttempts).toBe(3);
    for (const id of ['submission-stat', 'submit-request-upload', 'submit-put-bytes', 'poll-lb']) {
      expect(task(id)?.retryability, id).toBe('safe');
    }
  });

  it('poll-lb is a poll op task that projects the leaderboard score', () => {
    const poll = task('poll-lb');
    expect(poll?.operation).toBe('api.http.call');
    expect(poll?.dependsOn).toEqual(['submit-finalize']);
    expect(poll?.poll?.intervalMs).toBe(60000);
    expect(poll?.poll?.maxCycles).toBe(5);
    const projection = poll?.outputProjection as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual(['lbStatus', 'lbValue', 'submissionId']);
  });

  it('rejecting approve-submit skips the submit chain but NOT the learning tasks (reject-but-learn)', () => {
    const skip = computeRejectedApprovalSkipSet(
      wf.tasks as unknown as WorkflowTask[],
      'approve-submit',
    );
    // The approve gate + every when-gated submit-chain task is skipped.
    expect(skip).toEqual(
      new Set([
        'approve-submit',
        'submission-stat',
        'submit-request-upload',
        'submit-put-bytes',
        'submit-finalize',
        'poll-lb',
      ]),
    );
    // The always-on learning tasks run on the reject path with absent lb inputs.
    expect(skip.has('extract-learnings')).toBe(false);
    expect(skip.has('record-learnings')).toBe(false);
  });

  it('extract-learnings depends on poll-lb and binds lbValue + lbStatus', () => {
    const xl = task('extract-learnings');
    expect(xl?.dependsOn).toEqual(['poll-lb']);
    const bindings = xl?.inputBindings as Record<string, { taskId: string; path: string }>;
    expect(bindings['lbValue']).toEqual({
      kind: 'task_output',
      taskId: 'poll-lb',
      path: 'lbValue',
    });
    expect(bindings['lbStatus']).toEqual({
      kind: 'task_output',
      taskId: 'poll-lb',
      path: 'lbStatus',
    });
  });

  it('no agent task grants ai.text.generate_json or opTaskOnly tools', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
    const offenders = wf.tasks
      .filter((t) => t.type === 'agent')
      .filter((t) => (t.context?.capabilities?.operations ?? []).includes('ai.text.generate_json'))
      .map((t) => t.taskId);
    expect(offenders).toEqual([]);
  });

  it('prepare reads competitionSlug from the campaign with no per-run inputs', () => {
    const prepare = task('prepare');
    const bindings = prepare?.inputBindings as Record<string, { kind: string; path: string }>;
    expect(bindings['competitionSlug']).toEqual({
      kind: 'campaign_input',
      path: 'competitionSlug',
    });
    // No run_input bindings — a campaign run supplies no per-run inputs, and an
    // uncovered run_input binding hard-fails resolveTaskInputs.
    expect(Object.values(bindings).every((b) => b.kind !== 'run_input')).toBe(true);
    expect(prepare?.goal).toContain(
      '/workflows/kaggle-competition-optimizer/competitions/{competitionSlug}/data/',
    );
  });

  it('approve-submit resolves competitionName directly from the campaign config', () => {
    const approve = task('approve-submit');
    const preview = approve?.actionPreview as
      { inputBindings?: Record<string, { kind: string; path?: string }> } | undefined;
    expect(preview?.inputBindings?.['competitionName']).toEqual({
      kind: 'campaign_input',
      path: 'competitionSlug',
    });
  });

  it('prepare fetches via the Kaggle REST API, not MCP', () => {
    const prepare = task('prepare');
    const integrations = prepare?.context?.capabilities?.integrations ?? [];
    expect(integrations.every((i) => i.sourceKind === 'api')).toBe(true);
    const kaggle = integrations.find((i) => i.integrationId === 'kaggle');
    // Only the small-JSON listing endpoint is surfaced as a virtual tool. The
    // raw download endpoint is deliberately NOT — it would lower to an inline
    // api.http.call. File bytes go through the api.http.download op instead.
    expect(kaggle?.toolNames?.map((t) => t.toolName)).toEqual(['list_competition_data_files']);
  });

  it('prepare can only fetch file bytes via the destination-mandated download op', () => {
    const prepare = task('prepare');
    const ops = prepare?.context?.capabilities?.operations ?? [];
    // The streaming, destination-mandated op is the ONLY byte-fetch tool granted.
    expect(ops).toContain('api.http.download');
    // No generic inline HTTP op and no inline download virtual tool — a large
    // body cannot be pulled into the turn, only streamed to the cache path.
    expect(ops).not.toContain('api.http.call');
    const kaggle = (prepare?.context?.capabilities?.integrations ?? []).find(
      (i) => i.integrationId === 'kaggle',
    );
    const toolNames = kaggle?.toolNames?.map((t) => t.toolName) ?? [];
    expect(toolNames).not.toContain('download_competition_data_file');
    // The listing tool and memory reads stay available.
    expect(toolNames).toContain('list_competition_data_files');
    expect(ops).toContain('memory.store.get');
  });

  it('execute is gated on prepare.ready so it never runs on missing data', () => {
    const execute = task('execute');
    expect(execute?.when).toEqual({
      expression: 'tasks.prepare.output.ready == true',
      onMissingRef: 'skip',
    });
    // The gate expression parses under the supported when grammar.
    expect(validateWhenExpression(execute!.when!.expression)).toBeNull();
    // prepare declares `ready` (required) so the gate reads a real field.
    const prepareSchema = task('prepare')?.outputContract?.schema as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(prepareSchema.properties['ready']?.type).toBe('boolean');
    expect(prepareSchema.required).toContain('ready');
  });

  it('execute bindings and prepare contract fields are preserved; ready is additive', () => {
    const eb = task('execute')?.inputBindings as Record<string, unknown>;
    expect(eb['dataRootPath']).toEqual({
      kind: 'task_output',
      taskId: 'prepare',
      path: 'dataRootPath',
    });
    expect(eb['submissionTemplateFile']).toEqual({
      kind: 'task_output',
      taskId: 'prepare',
      path: 'submissionTemplateFile',
    });
    const props = (
      task('prepare')?.outputContract?.schema as { properties: Record<string, unknown> }
    ).properties;
    expect(props['dataRootPath']).toEqual({ type: 'string' });
    expect(props['filesAvailable']).toEqual({ type: 'array', items: { type: 'string' } });
    expect(props['submissionTemplateFile']).toEqual({ type: 'string' });
    expect(props['issues']).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('prepare prompt states the goal (size-validated, serial, unsupported-shape) with no op names or saveTo', () => {
    const goal = task('prepare')?.goal ?? '';
    // Size-validated cache-hit: skip only on a size match, re-fetch on mismatch.
    expect(goal.toLowerCase()).toContain('totalbytes');
    expect(goal.toLowerCase()).toMatch(/size/);
    // Serial downloads (memory pressure — one large body buffered at a time).
    expect(goal.toLowerCase()).toMatch(/one at a time|serial/);
    // Unsupported shape → issues diagnostic, not a silent partial prep.
    expect(goal).toContain('issues');
    expect(goal.toLowerCase()).toMatch(/zip|archive|shard|multi-part|layout/);
    // GOAL-ONLY: no op names, no saveTo mechanism — the Runner selects the
    // tool from its self-description. Endpoint COORDINATES are data, not
    // mechanism: the download endpoint is not a virtual tool and getSchema
    // strips minimalExampleInput, so the goal is the only place the Runner
    // can learn which endpoint carries the bytes.
    expect(goal).not.toContain('api.http.download');
    expect(goal).not.toContain('api.http.call');
    expect(goal).not.toContain('memory.store.get');
    expect(goal).not.toContain('saveTo');
    expect(goal).not.toContain('list_competition_data_files');
  });

  it('prepare goal carries the download-endpoint coordinates the Runner cannot discover', () => {
    const goal = task('prepare')?.goal ?? '';
    expect(goal).toContain('download_competition_data_file');
    expect(goal).toContain('kaggle-default');
    expect(goal).toContain('competitionName');
    expect(goal).toContain('fileName');
  });

  it('prepare tolerates auxiliary metadata files instead of rejecting the layout', () => {
    const goal = task('prepare')?.goal ?? '';
    // Metadata files (House Prices ships data_description.txt) are ignored,
    // never an unsupported layout.
    expect(goal).toContain('data_description.txt');
    expect(goal.toLowerCase()).toMatch(/metadata|auxiliary/);
    expect(goal.toLowerCase()).toContain('ignored');
    // The clause that misfired: bare non-CSV entries in the listing read as
    // an unsupported layout. Required files must be PRESENT; extras are fine.
    expect(goal.toLowerCase()).not.toContain('non-csv');
    expect(goal.toLowerCase()).not.toMatch(/exactly `?train\.csv`?, `?test\.csv/);
  });

  it('prepare gates `ready` on all three canonical files, consistently', () => {
    // The shape rule requires the template, `submissionTemplateFile` is a
    // required output, and the submit chain reads the file — so a two-file
    // `ready` rule would pass a competition whose template never arrived and
    // send `execute` to read a path that does not exist. Prose, the output
    // sketch and the JSON-schema description must agree.
    const goal = task('prepare')?.goal ?? '';
    expect(goal).toMatch(/ALL THREE/);
    expect(goal).not.toMatch(/mandatory pair/i);
    expect(goal).not.toMatch(/ONLY when BOTH/i);

    const schema = JSON.stringify(task('prepare')?.outputContract ?? {});
    expect(schema).toContain('submission_template.csv');
    expect(schema).not.toMatch(/True only when both train\.csv and test\.csv/i);
  });

  it('execute binds the metric from the campaign, not from prepare', () => {
    const bindings = task('execute')?.inputBindings as Record<string, { kind: string }>;
    expect(bindings['metricName']?.kind).toBe('campaign_input');
    expect(bindings['metricDirection']?.kind).toBe('campaign_input');
  });

  it('declares a campaign contract with competitionSlug as identity', () => {
    const campaign = entry.bundle.manifest.campaign;
    expect(campaign).toBeDefined();
    expect(Object.keys(campaign!.fields).sort()).toEqual([
      'competitionSlug',
      'metricDirection',
      'metricName',
      'targetScore',
    ]);
    expect(campaign!.fields['competitionSlug']!.identity).toBe(true);
  });

  it('goal direction + the leaderboard bar are $campaign references (no literal placeholder)', () => {
    expect(entry.bundle.manifest.goal).toMatchObject({
      direction: { $campaign: 'metricDirection' },
    });
    const evaluator = wf.outcomes[0]!.evaluator as Record<string, unknown>;
    expect(evaluator['target']).toEqual({ $campaign: 'targetScore' });
    expect(evaluator['operator']).toEqual({
      $campaign: 'metricDirection',
      map: { maximize: 'gte', minimize: 'lte' },
    });
  });

  it('is listed in the skill catalog with the expected slug', () => {
    expect(wf.slug).toBe(KAGGLE_SLUG);
  });
});

describe('kaggle-competition bundle', () => {
  const bundle = getSkillBundleEntry('kaggle-competition');
  if (!bundle) {
    throw new Error('bundle "kaggle-competition" not found');
  }

  it('ships no MCP server (moved to the REST API)', () => {
    expect(bundle.mcpDefinitions).toEqual([]);
    expect(bundle.mcpBindingTemplates).toEqual([]);
  });

  it('ships the kaggle Bearer API definition + the kaggle-data-fetch direct-URL binding', () => {
    expect(bundle.apiDefinitions.map((d) => d.apiId).sort()).toEqual([
      'kaggle',
      'kaggle-data-fetch',
    ]);
    const kaggle = bundle.apiBindingTemplates.find((b) => b.bindingId === 'kaggle-default');
    expect(kaggle?.authShape.type).toBe('bearer');
    expect(bundle.apiBindingTemplates.map((b) => b.bindingId)).toContain(
      'kaggle-data-fetch-default',
    );
    // kaggle-data-fetch is a direct_url subtype: no endpoints, auth none.
    const dataFetch = bundle.apiDefinitions.find((d) => d.apiId === 'kaggle-data-fetch');
    expect(dataFetch?.definition.callMode).toBe('direct_url');
    expect(dataFetch?.definition.endpoints).toEqual([]);
    expect(dataFetch?.definition.authKind).toBe('none');
    // Its binding template must use auth none — direct-URL mode never sends creds (P3.2).
    const dataFetchBinding = bundle.apiBindingTemplates.find(
      (b) => b.bindingId === 'kaggle-data-fetch-default',
    );
    expect(dataFetchBinding?.authShape.type).toBe('none');
  });

  it('every direct_url definition pairs only with auth-none binding templates', () => {
    const directUrlApiIds = new Set(
      bundle.apiDefinitions
        .filter((d) => d.definition.callMode === 'direct_url')
        .map((d) => d.apiId),
    );
    for (const tmpl of bundle.apiBindingTemplates) {
      if (directUrlApiIds.has(tmpl.apiId)) {
        expect(tmpl.authShape.type).toBe('none');
      }
    }
  });

  it('declares the submit endpoint as form-urlencoded (Kaggle rejects a JSON body)', () => {
    const kaggle = bundle.apiDefinitions.find((d) => d.apiId === 'kaggle');
    const submit = kaggle?.definition.endpoints.find(
      (e) => e.endpointId === 'submit_to_competition',
    );
    expect(submit?.body?.contentType).toBe('application/x-www-form-urlencoded');
  });
});
