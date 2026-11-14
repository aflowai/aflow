import { describe, expect, it } from 'vitest';
import { MEMORY_READ_OPERATION_ID } from '@aflow/schemas';
import {
  buildCallSignature,
  countRepeatedCall,
  countSameTargetReads,
  evaluateLoopTurn,
  readTargetEntries,
  repeatedReadWarning,
  sameTargetLoopWarning,
  type LoopTurnState,
  type LoopTurnVerdict,
  type RepeatVerdict,
  type SignatureCall,
} from '../callSignature.js';

const TARGET = '/run/outputs/abc123_0/data';
const WINDOW = 15_000;

interface Turn {
  identical: RepeatVerdict;
  sameTarget: RepeatVerdict;
  readCount: number;
  sameTargetWarning: ReturnType<typeof sameTargetLoopWarning>;
}

function runTurns(turns: ReadonlyArray<ReadonlyArray<SignatureCall>>): Turn[] {
  let signatures: string[] = [];
  let readTargets: string[][] = [];
  return turns.map((calls) => {
    const identical = countRepeatedCall(signatures, buildCallSignature(calls));
    const same = countSameTargetReads(readTargets, readTargetEntries(calls));
    signatures = identical.recentSignatures;
    readTargets = same.recentReadTargets;
    return {
      identical: identical.verdict,
      sameTarget: same.verdict,
      readCount: same.readCount,
      sameTargetWarning: sameTargetLoopWarning(same),
    };
  });
}

const byWindow = (i: number): SignatureCall[] => [
  {
    toolId: MEMORY_READ_OPERATION_ID,
    args: { target: { path: TARGET }, byteRange: { start: i * WINDOW, end: (i + 1) * WINDOW } },
  },
];
const byJsonPath = (i: number): SignatureCall[] => [
  {
    toolId: MEMORY_READ_OPERATION_ID,
    args: { target: { path: TARGET }, view: 'content', jsonPath: `tasks[${String(i)}]` },
  },
];
const turns = (n: number, at: (i: number) => SignatureCall[]) =>
  Array.from({ length: n }, (_, i) => at(i));

describe('probes from review d8c9e98e', () => {
  it('(a) 12 windowed reads of one target neither warn nor pause', () => {
    const loop = runTurns(turns(12, byWindow));
    expect(loop.map((t) => t.identical)).toEqual(Array(12).fill('none'));
    expect(loop.map((t) => t.sameTarget)).toEqual(Array(12).fill('none'));
    expect(loop.every((t) => t.sameTargetWarning === undefined)).toBe(true);
  });

  it('(b) 12 reads by distinct jsonPath warn at the 8th and pause at the 12th', () => {
    const loop = runTurns(turns(12, byJsonPath));
    expect(loop.map((t) => t.sameTarget)).toEqual([
      ...Array(7).fill('none'),
      'warning',
      'warning',
      'warning',
      'final_warning',
      'pause',
    ]);
    expect(loop.every((t) => t.identical === 'none')).toBe(true);
  });

  it('(c) the turn that crosses from 7 to 8 reads gets the warning, not a failure', () => {
    const loop = runTurns(turns(8, byJsonPath));
    expect(loop[6]?.readCount).toBe(7);
    expect(loop[7]?.readCount).toBe(8);
    expect(loop[7]?.sameTarget).not.toBe('pause');
    expect(loop[7]?.sameTargetWarning).toBeDefined();
  });

  it('(d) the same-target warning is distinguishable from the identical-call warning', () => {
    const warning = runTurns(turns(8, byJsonPath))[7]?.sameTargetWarning;
    expect(warning).toBeDefined();
    expect(warning?.message).not.toBe(repeatedReadWarning(3));
    expect(warning).toHaveProperty('rule', 'same_target');
  });

  it('(e) the same-target warning names the remedy', () => {
    const warning = runTurns(turns(8, byJsonPath))[7]?.sameTargetWarning;
    expect(warning?.message).toContain(
      'Read the target whole or by window, not section by section.',
    );
  });
});

/** Drives evaluateLoopTurn, the one call applyAgentDecision makes per turn. */
function runHandlerTurns(all: ReadonlyArray<ReadonlyArray<SignatureCall>>): LoopTurnVerdict[] {
  let state: LoopTurnState = { recentSignatures: [], recentReadTargets: [] };
  return all.map((calls) => {
    const verdict = evaluateLoopTurn(state, calls);
    state = verdict.state;
    return verdict;
  });
}

describe('probes through the per-turn loop verdict', () => {
  it('(a) 12 windowed reads of one target complete with no warning and no failure', () => {
    for (const verdict of runHandlerTurns(turns(12, byWindow))) {
      expect(verdict.failure).toBeUndefined();
      expect(verdict.identicalCall).toBeUndefined();
      expect(verdict.sameTarget).toBeUndefined();
    }
  });

  it('(b) 12 reads by distinct jsonPath warn at the 8th and fail at the 12th', () => {
    const loop = runHandlerTurns(turns(12, byJsonPath));
    expect(loop.slice(0, 7).every((v) => v.sameTarget === undefined)).toBe(true);
    expect(loop.slice(7, 11).every((v) => v.sameTarget?.warning.rule === 'same_target')).toBe(true);
    expect(loop.slice(0, 11).every((v) => v.failure === undefined)).toBe(true);
    expect(loop[11]?.failure?.rule).toBe('same_target');
    expect(loop.every((v) => v.identicalCall === undefined)).toBe(true);
  });

  it('(c) the turn that crosses from 7 to 8 reads warns and does not fail', () => {
    const eighth = runHandlerTurns(turns(8, byJsonPath))[7];
    expect(eighth?.failure).toBeUndefined();
    expect(eighth?.sameTarget?.warning.repeatedActionCount).toBe(8);
    expect(eighth?.sameTarget?.warning.severity).toBe('warning');
  });

  it('(d) the two rules write distinct warnings, and both reach a turn that trips both', () => {
    const sameRead = byJsonPath(0);
    const loop = runHandlerTurns([...turns(5, byJsonPath), sameRead, sameRead, sameRead]);
    const last = loop.at(-1);
    expect(last?.failure).toBeUndefined();
    expect(last?.identicalCall?.warning.rule).toBe('identical_call');
    expect(last?.sameTarget?.warning.rule).toBe('same_target');
    expect(last?.identicalCall?.warning.message).not.toBe(last?.sameTarget?.warning.message);
  });

  it('(e) the same-target warning names the remedy', () => {
    const eighth = runHandlerTurns(turns(8, byJsonPath))[7];
    expect(eighth?.sameTarget?.warning.message).toContain(
      'Read the target whole or by window, not section by section.',
    );
  });

  it('keeps the identical-call rule at 3 and 5 over windowed reads', () => {
    const loop = runHandlerTurns(turns(5, () => byWindow(0)));
    expect(loop[2]?.identicalCall?.warning.rule).toBe('identical_call');
    expect(loop[4]?.failure?.rule).toBe('identical_call');
    expect(loop.every((v) => v.sameTarget === undefined)).toBe(true);
  });
});
