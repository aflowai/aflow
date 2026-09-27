import { describe, expect, it } from 'vitest';
import { AppletDefinitionSchema, type AppletDefinitionInput } from '@aflow/schemas';
import {
  checkAppletConformance,
  extractAppletActCallSites,
  synthesizeMinimalAppletInput,
} from '../conformance.js';

function definitionOf(overrides: Partial<AppletDefinitionInput> = {}) {
  return AppletDefinitionSchema.parse({
    appletKey: 'counter',
    version: 1,
    name: 'Counter',
    description: 'A shared counter',
    semanticDescription: 'A shared tally the team sets together.',
    stateSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        status: { enum: ['open', 'closed'] },
      },
      required: ['count', 'status'],
      additionalProperties: false,
    },
    initialState: { count: 0, status: 'open' },
    actions: [
      {
        name: 'set_count',
        description: 'Set the tally',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
        patch: { template: [{ op: 'replace', path: '/state/count', valueFrom: '/input/value' }] },
      },
      {
        name: 'close',
        description: 'Close the counter',
        inputSchema: { type: 'object', additionalProperties: false },
        patch: { template: [{ op: 'replace', path: '/state/status', value: 'closed' }] },
        ends: true,
      },
    ],
    ...overrides,
  });
}

const CONFORMING_SOURCE = `
const button = document.createElement('button');
button.onclick = () => window.aflow.act('set_count', { value: 1 });
const closer = document.createElement('button');
closer.onclick = () => window.aflow.act('close', {});
`;

const ENTRY_ID_PATTERN = '^en_[0-9a-z]{6,18}$';

const ENTRY_ID_SCHEMA = {
  type: 'string',
  pattern: ENTRY_ID_PATTERN,
  minLength: 9,
  maxLength: 21,
};

/**
 * A collection keyed by ids the room mints — the shape whose templates the
 * gate could not replay against initialState.
 */
function ledgerDefinition(actions: AppletDefinitionInput['actions']) {
  return AppletDefinitionSchema.parse({
    appletKey: 'ledger',
    version: 1,
    name: 'Ledger',
    description: 'Entries the room keeps together',
    semanticDescription: 'A shared ledger of entries, each under an id the room mints.',
    stateSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'object',
          maxProperties: 40,
          propertyNames: { pattern: ENTRY_ID_PATTERN },
          additionalProperties: {
            type: 'object',
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 80 },
              status: { enum: ['open', 'settled'] },
            },
            required: ['label', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['entries'],
      additionalProperties: false,
    },
    initialState: { entries: {} },
    actions,
  });
}

const LEDGER_SOURCE = `window.aflow.act('set_label', { entryId: 'en_9f2k1d', label: 'rent' });`;

function setLabelAction(member: string) {
  return {
    name: 'set_label',
    description: 'Rename one entry',
    inputSchema: {
      type: 'object',
      properties: {
        entryId: ENTRY_ID_SCHEMA,
        label: { type: 'string', minLength: 1, maxLength: 80 },
      },
      required: ['entryId', 'label'],
      additionalProperties: false,
    },
    patch: {
      template: [
        {
          op: 'replace',
          pathTemplate: ['/state/entries', { from: '/input/entryId' }, member],
          valueFrom: '/input/label',
        },
      ],
    },
  } satisfies AppletDefinitionInput['actions'][number];
}

describe('extractAppletActCallSites', () => {
  it('extracts direct, window-prefixed and backtick-literal call sites', () => {
    const source = `
      aflow.act('set_count', { value: 1 });
      window.aflow.act("close", {});
      window.aflow.act(\`set_count\`, { value: 2 });
    `;
    const names = extractAppletActCallSites(source).map((site) => site.name);
    expect(names).toEqual(['set_count', 'close', 'set_count']);
  });

  it('records computed first arguments as dynamic', () => {
    const source = `
      window.aflow.act(actionName, {});
      aflow.act(flag ? 'a' : 'b', {});
      aflow.act(\`set_\${suffix}\`, {});
      aflow.act('set_' + suffix, {});
    `;
    const sites = extractAppletActCallSites(source);
    expect(sites).toHaveLength(4);
    expect(sites.every((site) => site.name === null)).toBe(true);
  });

  it('ignores act members of unrelated receivers and unrelated identifiers', () => {
    const source = `
      other.aflow.act('nope', {});
      myaflow.act('nope', {});
      interact('nope');
      React.act('nope');
    `;
    expect(extractAppletActCallSites(source)).toEqual([]);
  });

  it('follows a window.aflow alias', () => {
    const source = `
      const bridge = typeof window !== 'undefined' ? window.aflow : undefined;
      bridge.act('close', {});
    `;
    const sites = extractAppletActCallSites(source);
    expect(sites.map((site) => site.name)).toEqual(['close']);
  });

  it('follows a wrapper that forwards its first parameter to the bridge', () => {
    const source = `
      function act(name, input, extras) {
        const bridge = typeof window !== 'undefined' ? window.aflow : undefined;
        if (!bridge || typeof bridge.act !== 'function') return Promise.reject(new Error('no bridge'));
        return bridge.act(name, input, extras);
      }
      act('set_count', { value: 3 });
      act(
        'close',
        {},
      );
    `;
    const literalNames = extractAppletActCallSites(source)
      .map((site) => site.name)
      .filter((name) => name !== null);
    expect(literalNames).toEqual(['set_count', 'close']);
  });

  it('sees through optional chaining on every receiver shape', () => {
    const sites = extractAppletActCallSites(`
      window.aflow?.act('one', {});
      const bridge = window.aflow;
      bridge?.act('two', {});
      aflow?.act('three', {});
    `);
    expect(sites.map((s) => s.name)).toEqual(['one', 'two', 'three']);
  });

  it('follows a destructured act binding, renamed or not', () => {
    const sites = extractAppletActCallSites(`
      const { act } = window.aflow;
      act('plain', {});
      const { act: doIt } = window.aflow;
      doIt('renamed', {});
    `);
    expect(sites.map((s) => s.name)).toEqual(['plain', 'renamed']);
  });

  it('ignores commented-out call sites but keeps ones after a string containing //', () => {
    const sites = extractAppletActCallSites(`
      // window.aflow.act('ghost', {});
      /* aflow.act('block_ghost', {}); */
      const url = 'https://example.test//path';
      window.aflow.act('real', { url });
    `);
    expect(sites.map((s) => s.name)).toEqual(['real']);
  });

  it('does not count a wrapper declaration as a call site', () => {
    const source = `
      function act(name) { return window.aflow.act(name, {}); }
    `;
    const sites = extractAppletActCallSites(source);
    expect(sites.filter((site) => site.name !== null)).toEqual([]);
  });
});

describe('synthesizeMinimalAppletInput', () => {
  it('builds the smallest input from required members, bounds and enums', () => {
    const sample = synthesizeMinimalAppletInput({
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 3 },
        kind: { enum: ['expense', 'income'] },
        amount: { type: 'integer', minimum: 5, multipleOf: 3 },
        tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2 },
        fixed: { const: 42 },
      },
      required: ['id', 'kind', 'amount', 'tags', 'fixed'],
      additionalProperties: false,
    });
    expect(sample).toEqual({
      id: 'aaa',
      kind: 'expense',
      amount: 6,
      tags: ['a', 'a'],
      fixed: 42,
    });
  });

  it('honours a pattern, so an id-shaped input yields a valid sample', () => {
    expect(
      synthesizeMinimalAppletInput({
        type: 'object',
        properties: { entryId: ENTRY_ID_SCHEMA },
        required: ['entryId'],
        additionalProperties: false,
      }),
    ).toEqual({ entryId: 'en_000000' });
  });

  it('resolves document-local $refs', () => {
    const sample = synthesizeMinimalAppletInput({
      type: 'object',
      properties: { card: { $ref: '#/$defs/card' } },
      required: ['card'],
      $defs: {
        card: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    });
    expect(sample).toEqual({ card: { id: 'a' } });
  });

  it('returns undefined when the schema admits nothing', () => {
    expect(
      synthesizeMinimalAppletInput({
        type: 'object',
        properties: {},
        required: ['ghost'],
        additionalProperties: false,
      }),
    ).toBeUndefined();
  });
});

describe('checkAppletConformance', () => {
  it('passes a conforming definition and source clean', () => {
    const result = checkAppletConformance({
      definition: definitionOf(),
      source: CONFORMING_SOURCE,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('catches a drifted call site naming an undeclared action', () => {
    const result = checkAppletConformance({
      definition: definitionOf(),
      source: `${CONFORMING_SOURCE}\nwindow.aflow.act('reset_count', {});`,
    });
    expect(result.ok).toBe(false);
    const drift = result.errors.find((issue) => issue.code === 'unknown_action_call_site');
    expect(drift?.actionName).toBe('reset_count');
    expect(drift?.message).toContain("'set_count', 'close'");
    expect(drift?.message).toContain('raw_patch');
  });

  it('accepts a call site for the built-in raw_patch', () => {
    const result = checkAppletConformance({
      definition: definitionOf(),
      source: `${CONFORMING_SOURCE}\nwindow.aflow.act('raw_patch', { summary: 'edit' }, { patch: [] });`,
    });
    expect(result.errors).toEqual([]);
  });

  it('fails when every call site is dynamic, without piling on missing-call-site warnings', () => {
    const result = checkAppletConformance({
      definition: definitionOf(),
      source: `const name = pick(); window.aflow.act(name, {});`,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(['all_call_sites_dynamic']);
    expect(result.warnings).toEqual([]);
  });

  it('warns for a human-facing action with no call site and stays ok', () => {
    const result = checkAppletConformance({
      definition: definitionOf(),
      source: `window.aflow.act('set_count', { value: 1 });`,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(['missing_call_site']);
    expect(result.warnings[0]?.actionName).toBe('close');
  });

  it('does not warn for an agent-only action with no call site', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'set_count',
          description: 'Set the tally',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
            additionalProperties: false,
          },
          patch: {
            template: [{ op: 'replace', path: '/state/count', valueFrom: '/input/value' }],
          },
          audience: 'agent',
        },
      ],
    });
    const result = checkAppletConformance({ definition, source: 'const noop = 1;' });
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('catches a template whose replayed state violates the stateSchema', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'break_status',
          description: 'Corrupt the status',
          inputSchema: { type: 'object', additionalProperties: false },
          patch: { template: [{ op: 'replace', path: '/state/status', value: 'exploded' }] },
        },
      ],
    });
    const result = checkAppletConformance({
      definition,
      source: `window.aflow.act('break_status', {});`,
    });
    expect(result.ok).toBe(false);
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.actionName).toBe('break_status');
    expect(failure?.message).toContain('stateSchema');
  });

  it('catches a template that cannot apply to initialState', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'approve_missing',
          description: 'Replace a member initialState lacks',
          inputSchema: { type: 'object', additionalProperties: false },
          patch: { template: [{ op: 'replace', path: '/state/missing/flag', value: true }] },
        },
      ],
    });
    const result = checkAppletConformance({
      definition,
      source: `window.aflow.act('approve_missing', {});`,
    });
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.actionName).toBe('approve_missing');
    expect(failure?.message).toContain('initialState');
  });

  it('catches a template referencing an input field the schema does not require', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'set_count',
          description: 'Set the tally',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            additionalProperties: false,
          },
          patch: {
            template: [{ op: 'replace', path: '/state/count', valueFrom: '/input/value' }],
          },
        },
      ],
    });
    const result = checkAppletConformance({
      definition,
      source: `window.aflow.act('set_count', {});`,
    });
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.actionName).toBe('set_count');
    expect(failure?.message).toContain('requires');
  });

  it('catches a replayed state that does not survive a canonical reload', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'poison',
          description: 'Write a non-JSON number',
          inputSchema: { type: 'object', additionalProperties: false },
          patch: { template: [{ op: 'replace', path: '/state/count', value: Number.NaN }] },
        },
      ],
    });
    const result = checkAppletConformance({
      definition,
      source: `window.aflow.act('poison', {});`,
    });
    const failure = result.errors.find((issue) => issue.code === 'reload_convergence_failed');
    expect(failure?.actionName).toBe('poison');
  });

  it('skips replay for actor_supplied actions', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'move',
          description: 'Move something — the actor computes the patch',
          inputSchema: {
            type: 'object',
            properties: { target: { type: 'string', minLength: 1 } },
            required: ['target'],
            additionalProperties: false,
          },
          patch: 'actor_supplied',
        },
      ],
    });
    const result = checkAppletConformance({
      definition,
      source: `window.aflow.act('move', { target: 'a' }, { patch: [] });`,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('fails an action whose input schema admits nothing, instead of skipping its replay', () => {
    const definition = definitionOf({
      actions: [
        {
          name: 'strange',
          description: 'Requires a member its own schema forbids',
          inputSchema: {
            type: 'object',
            properties: {},
            required: ['ghost'],
            additionalProperties: false,
          },
          patch: { template: [{ op: 'replace', path: '/state/count', value: 1 }] },
        },
      ],
    });
    const result = checkAppletConformance({
      definition,
      source: `window.aflow.act('strange', {});`,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(['sample_input_unsatisfiable']);
    expect(result.warnings).toEqual([]);
  });
});

describe('checkAppletConformance — templates keyed by an id the room mints', () => {
  it('replays a template that writes into a dynamically-keyed member', () => {
    const result = checkAppletConformance({
      definition: ledgerDefinition([setLabelAction('label')]),
      source: LEDGER_SOURCE,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('fails a dynamically-keyed template whose member the stateSchema does not describe', () => {
    const result = checkAppletConformance({
      definition: ledgerDefinition([setLabelAction('labe')]),
      source: LEDGER_SOURCE,
    });
    expect(result.ok).toBe(false);
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.actionName).toBe('set_label');
    expect(failure?.message).toContain('/state/entries');
    expect(failure?.message).toContain('labe');
  });

  it('fails when the ids the input admits are not keys the state map accepts', () => {
    const action = setLabelAction('label');
    const result = checkAppletConformance({
      definition: ledgerDefinition([
        {
          ...action,
          inputSchema: {
            ...action.inputSchema,
            properties: {
              ...action.inputSchema.properties,
              entryId: { type: 'string', pattern: '^X[0-9]{3}$', minLength: 4, maxLength: 4 },
            },
          },
        },
      ]),
      source: LEDGER_SOURCE,
    });
    expect(result.ok).toBe(false);
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.message).toContain('stateSchema');
  });

  it('fails a dynamically-keyed template whose write violates the stateSchema', () => {
    const result = checkAppletConformance({
      definition: ledgerDefinition([
        {
          name: 'set_label',
          description: 'Write a status the schema forbids',
          inputSchema: {
            type: 'object',
            properties: { entryId: ENTRY_ID_SCHEMA },
            required: ['entryId'],
            additionalProperties: false,
          },
          patch: {
            template: [
              {
                op: 'replace',
                pathTemplate: ['/state/entries', { from: '/input/entryId' }, 'status'],
                value: 'archived',
              },
            ],
          },
        },
      ]),
      source: LEDGER_SOURCE,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain('template_replay_failed');
  });

  it('keeps a wholly literal path strict — seeding never covers one', () => {
    const result = checkAppletConformance({
      definition: ledgerDefinition([
        {
          name: 'set_label',
          description: 'Write into a literal key initialState lacks',
          inputSchema: { type: 'object', additionalProperties: false },
          patch: {
            template: [{ op: 'replace', path: '/state/entries/en_9f2k1d/label', value: 'rent' }],
          },
        },
      ]),
      source: LEDGER_SOURCE,
    });
    expect(result.ok).toBe(false);
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.message).toContain('initialState');
  });

  it('proves a test path resolves without judging the domain fact it asserts', () => {
    const result = checkAppletConformance({
      definition: ledgerDefinition([
        {
          name: 'set_label',
          description: 'Settle an entry that is currently open',
          inputSchema: {
            type: 'object',
            properties: {
              entryId: ENTRY_ID_SCHEMA,
              expected: { enum: ['settled', 'open'] },
            },
            required: ['entryId', 'expected'],
            additionalProperties: false,
          },
          patch: {
            template: [
              {
                op: 'test',
                pathTemplate: ['/state/entries', { from: '/input/entryId' }, 'status'],
                valueFrom: '/input/expected',
              },
              {
                op: 'replace',
                pathTemplate: ['/state/entries', { from: '/input/entryId' }, 'status'],
                value: 'settled',
              },
            ],
          },
        },
      ]),
      source: LEDGER_SOURCE,
    });
    expect(result.errors).toEqual([]);
  });

  it('fails a test asserting a value the stateSchema never admits at that path', () => {
    const result = checkAppletConformance({
      definition: ledgerDefinition([
        {
          name: 'set_label',
          description: 'Assert a status that cannot exist',
          inputSchema: {
            type: 'object',
            properties: { entryId: ENTRY_ID_SCHEMA },
            required: ['entryId'],
            additionalProperties: false,
          },
          patch: {
            template: [
              {
                op: 'test',
                pathTemplate: ['/state/entries', { from: '/input/entryId' }, 'status'],
                value: 'archived',
              },
              {
                op: 'replace',
                pathTemplate: ['/state/entries', { from: '/input/entryId' }, 'status'],
                value: 'settled',
              },
            ],
          },
        },
      ]),
      source: LEDGER_SOURCE,
    });
    expect(result.ok).toBe(false);
    const failure = result.errors.find((issue) => issue.code === 'template_replay_failed');
    expect(failure?.message).toContain('never admits');
  });
});
