import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configureLogging } from '@aflow/observability';
import {
  registerValidator,
  registerRuntimeValidator,
  lookupValidator,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';

configureLogging({ service: 'test', level: 'silent' });
import {
  runRegisteredOutputValidators,
  formatOutputValidatorIssues,
} from '../scheduling/runOutputValidators.js';
// Side-effect import: registers compose.task-graph-draft + the other validators.
import '../scheduling/composeTaskGraphDraftValidator.js';
import '../scheduling/apiDefinitionDraftValidator.js';

const ctx = {
  tenantId: 't',
  spaceId: 's',
  runId: 'r',
  db: {},
};

// Unique names so we never collide with the real registrations in this file.
registerValidator('test.pure.shape', z.object({ a: z.string() }));
registerRuntimeValidator('test.runtime.always', async (): Promise<RuntimeValidatorIssue[]> => [
  { code: 'custom', path: ['x', 0], message: 'runtime says no' },
]);

describe('runRegisteredOutputValidators', () => {
  it('returns no issues when a pure validator passes', async () => {
    const issues = await runRegisteredOutputValidators(['test.pure.shape'], { a: 'ok' }, ctx);
    expect(issues).toEqual([]);
  });

  it('surfaces pure-validator issues with path + message', async () => {
    const issues = await runRegisteredOutputValidators(['test.pure.shape'], { a: 1 }, ctx);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toContain('a');
  });

  it('runs runtime validators and surfaces their issues', async () => {
    const issues = await runRegisteredOutputValidators(['test.runtime.always'], {}, ctx);
    expect(issues).toEqual([{ path: ['x', 0], message: 'runtime says no' }]);
  });

  it('skips an unknown ref without throwing', async () => {
    const issues = await runRegisteredOutputValidators(['no.such.validator'], {}, ctx);
    expect(issues).toEqual([]);
  });

  it('formats issues into leading-/path lines', () => {
    expect(
      formatOutputValidatorIssues([
        { path: ['tasks', 0, 'kind'], message: 'bad' },
        { path: [], message: 'root issue' },
      ]),
    ).toEqual(['/tasks/0/kind: bad', '(root): root issue']);
  });
});

describe('compose.task-graph-draft registration', () => {
  it('registers TaskGraphDraftSchema as a pure validator at module load', () => {
    const v = lookupValidator('compose.task-graph-draft');
    expect(v?.kind).toBe('pure');
  });

  it('the registered draft validator rejects a grant-less fetcher', async () => {
    const draft = {
      slug: 'x-skill',
      name: 'X',
      description: '',
      goal: 'g',
      outcomes: [{ id: 'o', name: 'O', evaluator: { type: 'manual', instruction: 'm' } }],
      tasks: [{ type: 'agent', kind: 'fetcher', taskId: 'f', goal: 'fetch' }],
    };
    const issues = await runRegisteredOutputValidators(['compose.task-graph-draft'], draft, ctx);
    expect(issues.some((i) => i.message.includes('callable external source'))).toBe(true);
  });
});

/**
 * `toJsonSchemaSync` drops superRefine, so the draft's cross-field rules reach
 * the Runner's submit_output only through this ref. Without it a `$ref` into a
 * spec passes the authoring task and fails one hop later at propose, after the
 * Runner can no longer self-correct.
 */
describe('capability.api-definition-draft registration', () => {
  it('registers ApiDefinitionDraftSchema as a pure validator at module load', () => {
    const v = lookupValidator('capability.api-definition-draft');
    expect(v?.kind).toBe('pure');
  });

  it('rejects an endpoint schema that references a spec the draft does not carry', async () => {
    const draft = {
      name: 'Billing',
      baseUrl: 'https://api.example.com',
      authKind: 'none',
      callMode: 'endpoint',
      endpoints: [
        {
          path: '/orders',
          method: 'POST',
          body: {
            contentType: 'application/json',
            schema: { $ref: '#/components/schemas/NewOrder' },
          },
        },
      ],
    };
    // The task submits the WRAPPER, and a registered validator sees the whole
    // output — validating the inner schema here would reject every valid draft.
    const issues = await runRegisteredOutputValidators(
      ['capability.api-definition-draft'],
      { apiDefinition: draft },
      ctx,
    );
    expect(issues.some((i) => i.message.includes('#/components/schemas/NewOrder'))).toBe(true);
  });

  it('accepts the same draft once the shape is inlined', async () => {
    const draft = {
      name: 'Billing',
      baseUrl: 'https://api.example.com',
      authKind: 'none',
      callMode: 'endpoint',
      endpoints: [
        {
          path: '/orders',
          method: 'POST',
          body: {
            contentType: 'application/json',
            schema: { type: 'object', properties: { sku: { type: 'string' } } },
          },
        },
      ],
    };
    const issues = await runRegisteredOutputValidators(
      ['capability.api-definition-draft'],
      { apiDefinition: draft },
      ctx,
    );
    expect(issues).toEqual([]);
  });
});
