import { describe, expect, it, vi } from 'vitest';
import { computeAppletDefinitionHash } from '@aflow/applet-runtime';
import {
  parseRepairedDefinition,
  resolveAppletDefinition,
  validateAppletDefinitionCandidate,
} from './appletDefinitionEmission.js';

const VALID_CANDIDATE = {
  appletKey: 'team-counter',
  version: 1,
  name: 'Team Counter',
  description: 'A counter the team increments together',
  semanticDescription: 'A shared tally anyone can set; closing it ends the item.',
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
  attentionProjection: { status: '/status' },
};

const SOURCE = `document.body.append('counter'); window.aflow.act('set_count', { value: 1 }); window.aflow.act('close', {});`;

describe('validateAppletDefinitionCandidate', () => {
  it('round-trips a valid candidate with defaults materialized and a canonical hash', () => {
    const result = validateAppletDefinitionCandidate(VALID_CANDIDATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.appletKey).toBe('team-counter');
    expect(result.definition.recentActionsLimit).toBeGreaterThan(0);
    expect(result.definition.actions[0]?.audience).toBe('both');
    expect(result.definition.actions[0]?.notable).toBe(false);
    expect(result.definition.actions[1]?.ends).toBe(true);
    expect(result.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.definitionHash).toBe(computeAppletDefinitionHash(result.definition));
  });

  it('hashes identically regardless of candidate key order', () => {
    const reordered = JSON.parse(JSON.stringify(VALID_CANDIDATE)) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    const a = validateAppletDefinitionCandidate(VALID_CANDIDATE);
    const b = validateAppletDefinitionCandidate(shuffled);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.definitionHash).toBe(b.definitionHash);
  });

  it('rejects a declared raw_patch action — it is built in', () => {
    const candidate = {
      ...VALID_CANDIDATE,
      actions: [
        ...VALID_CANDIDATE.actions,
        {
          name: 'raw_patch',
          description: 'Free-form edit',
          inputSchema: { type: 'object' },
          patch: 'actor_supplied',
        },
      ],
    };
    const result = validateAppletDefinitionCandidate(candidate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('raw_patch');
  });

  it('rejects an initialState that violates the stateSchema', () => {
    const candidate = { ...VALID_CANDIDATE, initialState: { count: 'zero', status: 'open' } };
    const result = validateAppletDefinitionCandidate(candidate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('initialState'))).toBe(true);
  });

  it('rejects a non-object candidate', () => {
    expect(validateAppletDefinitionCandidate('nope').ok).toBe(false);
    expect(validateAppletDefinitionCandidate([VALID_CANDIDATE]).ok).toBe(false);
  });
});

describe('parseRepairedDefinition', () => {
  it('accepts a bare definition, a fenced one, and a { definition } wrapper', () => {
    const bare = JSON.stringify(VALID_CANDIDATE);
    expect(parseRepairedDefinition(bare)).toMatchObject({ appletKey: 'team-counter' });
    expect(parseRepairedDefinition('```json\n' + bare + '\n```')).toMatchObject({
      appletKey: 'team-counter',
    });
    expect(parseRepairedDefinition(JSON.stringify({ definition: VALID_CANDIDATE }))).toMatchObject({
      appletKey: 'team-counter',
    });
    expect(parseRepairedDefinition('not json')).toBeUndefined();
  });
});

describe('resolveAppletDefinition', () => {
  it('returns the definition without a repair call when the candidate is valid', async () => {
    const repair = vi.fn();
    const result = await resolveAppletDefinition({
      candidate: VALID_CANDIDATE,
      source: SOURCE,
      repair,
    });
    expect(result.definition?.appletKey).toBe('team-counter');
    expect(result.diagnostics).toHaveLength(0);
    expect(result.repaired).toBe(false);
    expect(repair).not.toHaveBeenCalled();
  });

  it('fails with APPLET_DEFINITION_MISSING when nothing was emitted and no repair is available', async () => {
    const result = await resolveAppletDefinition({ candidate: undefined, source: SOURCE });
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('APPLET_DEFINITION_MISSING');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });

  it('repairs an invalid candidate in one round and reports usage', async () => {
    const usage = {
      provider: 'test',
      model: 'test-model',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      promptCostUsd: 0,
      completionCostUsd: 0,
      totalCostUsd: 0,
    };
    const broken = { ...VALID_CANDIDATE, initialState: { count: 'zero', status: 'open' } };
    const repair = vi.fn().mockResolvedValue({
      content: JSON.stringify(VALID_CANDIDATE),
      usage,
    });
    const result = await resolveAppletDefinition({ candidate: broken, source: SOURCE, repair });
    expect(result.definition?.appletKey).toBe('team-counter');
    expect(result.diagnostics).toHaveLength(0);
    expect(result.repaired).toBe(true);
    expect(result.usage).toEqual(usage);
    expect(repair).toHaveBeenCalledTimes(1);
    const messages = repair.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.content.includes('initialState'))).toBe(true);
    expect(messages.some((m) => m.content.includes(SOURCE))).toBe(true);
  });

  it('authors a missing definition through the repair round', async () => {
    const repair = vi.fn().mockResolvedValue({ content: JSON.stringify(VALID_CANDIDATE) });
    const result = await resolveAppletDefinition({ candidate: undefined, source: SOURCE, repair });
    expect(result.definition?.appletKey).toBe('team-counter');
    expect(result.repaired).toBe(true);
  });

  it('keeps the failure diagnostics when the repair round returns garbage', async () => {
    const repair = vi.fn().mockResolvedValue({ content: 'still not json' });
    const result = await resolveAppletDefinition({ candidate: undefined, source: SOURCE, repair });
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('APPLET_DEFINITION_MISSING');
    expect(result.repaired).toBe(false);
  });

  it('reports APPLET_DEFINITION_INVALID when the repaired candidate still fails', async () => {
    const broken = { ...VALID_CANDIDATE, appletKey: 'Not Kebab' };
    const repair = vi.fn().mockResolvedValue({ content: JSON.stringify(broken) });
    const result = await resolveAppletDefinition({ candidate: broken, source: SOURCE, repair });
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('APPLET_DEFINITION_INVALID');
  });

  it('routes a nonconformant definition through the repair round and reports APPLET_CONFORMANCE_INVALID', async () => {
    const driftedSource = `window.aflow.act('reset_count', {});`;
    const repair = vi.fn().mockResolvedValue({ content: JSON.stringify(VALID_CANDIDATE) });
    const result = await resolveAppletDefinition({
      candidate: VALID_CANDIDATE,
      source: driftedSource,
      repair,
    });
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('APPLET_CONFORMANCE_INVALID');
    expect(result.diagnostics[0]?.severity).toBe('error');
    expect(result.diagnostics[0]?.message).toContain('reset_count');
    expect(repair).toHaveBeenCalledTimes(1);
    const messages = repair.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.content.includes('reset_count'))).toBe(true);
  });

  it('surfaces conformance warnings without withholding the definition', async () => {
    const partialSource = `window.aflow.act('set_count', { value: 1 });`;
    const result = await resolveAppletDefinition({
      candidate: VALID_CANDIDATE,
      source: partialSource,
    });
    expect(result.definition?.appletKey).toBe('team-counter');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.diagnostics[0]?.code).toBe('APPLET_CONFORMANCE_WARNING');
    expect(result.diagnostics[0]?.message).toContain('close');
  });
});
