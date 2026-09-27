import { describe, it, expect } from 'vitest';
import { TaskGraphDraftSchema, type ComposeIntent, type DesignSurface } from '@aflow/schemas';
import {
  validateTaskGraphSelfConsistent,
  validateSourceCoverage,
  validateSurfaceConformance,
} from '../scheduling/composeValidators.js';

//6 — a compose draft matching the canonical kaggle submit-put-bytes
// shape (operation task, api.http.call, apiId + bindingId + url, bodySource) must
// pass the IR parse + all three compose validators end-to-end against a surface
// that exposes a direct_url binding.

const SURFACE: DesignSurface = {
  integrations: [
    {
      sourceKind: 'api',
      integrationId: 'kaggle',
      bindingId: 'kaggle-default',
      callMode: 'endpoint',
      toolNames: ['request_submission_upload'],
    },
    {
      sourceKind: 'api',
      integrationId: 'kaggle-data-fetch',
      bindingId: 'kaggle-data-fetch-default',
      callMode: 'direct_url',
      toolNames: [],
    },
  ],
  operations: ['api.http.call'],
  policies: { compute: false },
} as unknown as DesignSurface;

const INTENT: ComposeIntent = {
  intent: 'submit a file to a signed cross-host upload URL',
  iterationModel: 'process',
  requiredCapabilities: [],
  requiredDataSources: [],
  taskShapeHints: [],
  pauseForUser: { needed: false },
} as ComposeIntent;

const DRAFT = {
  slug: 'kaggle-submit-roundtrip',
  name: 'Kaggle submit round-trip',
  description: 'd',
  goal: 'g',
  outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
  tasks: [
    {
      type: 'agent',
      kind: 'fetcher',
      taskId: 'request-slot',
      goal: 'Request a resumable upload slot; the response carries createUrl.',
      dependsOn: [],
      consumes: [],
      produces: [{ key: 'createUrl', semantics: 'data', shape: { type: 'string' } }],
      context: {
        capabilities: {
          integrations: [
            {
              sourceKind: 'api',
              integrationId: 'kaggle',
              bindingId: 'kaggle-default',
              toolNames: ['request_submission_upload'],
            },
          ],
          operations: [],
        },
      },
    },
    {
      type: 'operation',
      taskId: 'put-bytes',
      operationId: 'api.http.call',
      dependsOn: ['request-slot'],
      consumes: [{ taskId: 'request-slot', outputKey: 'createUrl', bindAs: 'createUrl' }],
      produces: [],
      inputTemplate: {
        apiId: 'kaggle-data-fetch',
        bindingId: 'kaggle-data-fetch-default',
        url: { $bind: 'createUrl' },
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        response: { format: 'text' },
      },
      retryability: 'unsafe',
    },
  ],
};

describe('compose direct-URL round-trip', () => {
  it('the operation-task direct-URL shape parses as a TaskGraphDraft', () => {
    const parsed = TaskGraphDraftSchema.safeParse(DRAFT);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes all three compose validators end-to-end', () => {
    const parsed = TaskGraphDraftSchema.parse(DRAFT);
    expect(validateTaskGraphSelfConsistent(parsed)).toEqual({ valid: true });
    expect(validateSourceCoverage(INTENT, parsed)).toEqual({ valid: true });
    expect(validateSurfaceConformance(parsed, SURFACE)).toEqual({ valid: true });
  });

  it('surface conformance flags an operation task whose binding is not in the surface', () => {
    const parsed = TaskGraphDraftSchema.parse(DRAFT);
    const surfaceMissingDataFetch: DesignSurface = {
      ...SURFACE,
      integrations: SURFACE.integrations.filter((i) => i.integrationId !== 'kaggle-data-fetch'),
    } as unknown as DesignSurface;
    const result = validateSurfaceConformance(parsed, surfaceMissingDataFetch);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.violations.some((v) => v.message.includes('does not list that API'))).toBe(true);
  });
});
