import { describe, expect, it } from 'vitest';
import type { AppletActionGuard } from '@aflow/schemas';
import { evaluateAppletActionGuard } from '../guard.js';
import { renderAppletAgentGrid } from '../gridView.js';
import { materializeAppletTemplatePatch } from '../template.js';
import { applyAppletStatePatch } from '../applyStatePatch.js';

const GUARD: AppletActionGuard = {
  assert: ['/state/allowed', { from: '/input/key' }],
  equals: true,
  freshness: { stamp: '/state/allowedFor', matchesLengthOf: '/state/log' },
  onUnverifiable: 'allow',
  bypass: '/input/force',
  message: 'not allowed',
};

const FRESH_STATE = { allowed: { open: true }, allowedFor: 2, log: ['a', 'b'] };

describe('evaluateAppletActionGuard', () => {
  it('passes when the asserted member holds the expected value', () => {
    expect(
      evaluateAppletActionGuard({ guard: GUARD, state: FRESH_STATE, input: { key: 'open' } }),
    ).toEqual({ ok: true });
  });

  it('rejects a missing member and a wrong value with the taught message', () => {
    const missing = evaluateAppletActionGuard({
      guard: GUARD,
      state: FRESH_STATE,
      input: { key: 'shut' },
    });
    expect(missing).toEqual({ ok: false, message: 'not allowed' });
    const wrong = evaluateAppletActionGuard({
      guard: GUARD,
      state: { ...FRESH_STATE, allowed: { open: false } },
      input: { key: 'open' },
    });
    expect(wrong).toEqual({ ok: false, message: 'not allowed' });
  });

  it('a truthy bypass input skips the guard entirely', () => {
    expect(
      evaluateAppletActionGuard({
        guard: GUARD,
        state: FRESH_STATE,
        input: { key: 'shut', force: true },
      }),
    ).toEqual({ ok: true });
  });

  it('stale derived data resolves through onUnverifiable in both modes', () => {
    const stale = { ...FRESH_STATE, log: ['a', 'b', 'c'] };
    expect(
      evaluateAppletActionGuard({ guard: GUARD, state: stale, input: { key: 'shut' } }),
    ).toEqual({ ok: true });
    expect(
      evaluateAppletActionGuard({
        guard: { ...GUARD, onUnverifiable: 'reject' },
        state: stale,
        input: { key: 'open' },
      }),
    ).toEqual({ ok: false, message: 'not allowed' });
  });

  it('an unmaterializable assert path rejects instead of throwing', () => {
    expect(evaluateAppletActionGuard({ guard: GUARD, state: FRESH_STATE, input: {} })).toEqual({
      ok: false,
      message: 'not allowed',
    });
  });
});

describe('template test ops', () => {
  it('materializes and enforces an actor-asserted precondition', () => {
    const template = [
      {
        op: 'test' as const,
        pathTemplate: ['/state/cells', { from: '/input/at' }],
        valueFrom: '/input/expect',
      },
      { op: 'replace' as const, pathTemplate: ['/state/cells', { from: '/input/at' }], value: 'x' },
    ];
    const state = { cells: { a: 'y' } };
    const good = materializeAppletTemplatePatch(template, { at: 'a', expect: 'y' });
    expect(applyAppletStatePatch(state, good)).toEqual({ cells: { a: 'x' } });
    const bad = materializeAppletTemplatePatch(template, { at: 'a', expect: 'z' });
    expect(() => applyAppletStatePatch(state, bad)).toThrow();
  });
});

describe('renderAppletAgentGrid', () => {
  it('renders a labeled grid with empties and a legend', () => {
    const grid = renderAppletAgentGrid(
      {
        mapPath: '/cells',
        rowLabels: ['2', '1'],
        colLabels: ['a', 'b'],
        keyOrder: 'colRow',
        emptyAs: '.',
        legend: 'x marks the spot',
      },
      { cells: { a2: 'x', b1: 'o' } },
    );
    expect(grid).toBe('  a b\n2 x .\n1 . o\nx marks the spot');
  });

  it('returns undefined when the map member is absent or not an object', () => {
    const spec = {
      mapPath: '/cells',
      rowLabels: ['1'],
      colLabels: ['a'],
      keyOrder: 'colRow' as const,
      emptyAs: '.',
    };
    expect(renderAppletAgentGrid(spec, {})).toBeUndefined();
    expect(renderAppletAgentGrid(spec, { cells: 7 })).toBeUndefined();
  });
});
