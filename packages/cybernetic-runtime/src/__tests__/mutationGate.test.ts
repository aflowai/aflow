import { describe, it, expect } from 'vitest';
import { CaseExpectationSchema, type CaseExpectation } from '@aflow/schemas';

import { runDeterministicGate, deterministicMutants } from '../mutationGate.js';

const parse = (raw: unknown[]): CaseExpectation[] => raw.map((r) => CaseExpectationSchema.parse(r));

describe('the gate runs both directions', () => {
  it('passes a check that accepts its reference and rejects its defect', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          name: 'called it',
          check: { op: 'called', endpointId: 'order_inspect', expect: 'any' },
        },
      ]),
    });
    expect(report.referencePasses).toBe(true);
    expect(report.unwitnessed).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('refuses a case whose reference does not pass', () => {
    // A check that always fails rejects every mutant and would otherwise
    // satisfy the gate perfectly — the shape of a suite that measures nothing
    // while looking rigorous.
    const report = runDeterministicGate({
      expectations: parse([
        { kind: 'terminal', runStatus: 'completed' },
        { kind: 'terminal', runStatus: 'failed' },
      ]),
    });
    expect(report.referencePasses).toBe(false);
    expect(report.passed).toBe(false);
  });

  it('will not treat a check kind it cannot synthesise as satisfied', () => {
    const report = runDeterministicGate({
      expectations: parse([{ kind: 'task_status', taskId: 'answer', status: 'succeeded' }]),
    });
    expect(report.unsupported).toContain('task_status');
    expect(report.passed).toBe(false);
  });
});

describe('the mutants defeat the checks they target', () => {
  it('catches a forbidden write', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          name: 'opened no case',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ]),
    });
    expect(report.witnesses.map((w) => w.rejected)).toEqual([true]);
  });

  it('catches a write against the wrong record', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          name: 'the right handover',
          check: { op: 'mutated', collection: 'handovers', change: 'create', entityId: 'HO-1' },
        },
      ]),
    });
    expect(report.passed).toBe(true);
    expect(report.witnesses.some((w) => w.mutantId.startsWith('wrong-entity'))).toBe(true);
  });

  it('catches a count that exceeds the bound, for any bound', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          name: 'exactly one handover',
          check: {
            op: 'mutated',
            collection: 'handovers',
            change: 'create',
            times: { exactly: 1 },
          },
        },
      ]),
    });
    expect(report.witnesses.some((w) => w.mutantId.startsWith('count'))).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('violates a generous bound and a zero bound alike', () => {
    // Duplicating the reference list does not guarantee a violation: atMost 10
    // survives doubling, and exactly 0 has nothing to duplicate. Both valid
    // checks were reported as unable to fail.
    for (const times of [{ atMost: 10 }, { exactly: 0 }]) {
      const report = runDeterministicGate({
        expectations: parse([
          {
            kind: 'simulation',
            name: 'bounded',
            check: { op: 'mutated', collection: 'handovers', change: 'create', times },
          },
        ]),
      });
      expect(report.unwitnessed, JSON.stringify(times)).toEqual([]);
      expect(report.referencePasses, JSON.stringify(times)).toBe(true);
    }
  });

  it('catches a forbidden call by making it', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          name: 'never escalated',
          check: { op: 'called', endpointId: 'handover_start', expect: 'none' },
        },
      ]),
    });
    expect(report.referencePasses).toBe(true);
    expect(report.unwitnessed).toEqual([]);
  });

  it('honours a case that pins its simulation', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          simulationId: 'cs-desk',
          name: 'called it',
          check: { op: 'called', endpointId: 'order_inspect', expect: 'any' },
        },
      ]),
    });
    expect(report.referencePasses).toBe(true);
  });

  it('catches a reply that says what it must not', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'reply',
          name: 'no invented ref',
          check: { op: 'not_contains', pattern: 'PAY-\\d' },
        },
      ]),
    });
    expect(report.passed).toBe(true);
  });

  it('generates a mutant per check, not per case', () => {
    const mutants = deterministicMutants(
      parse([
        { kind: 'simulation', name: 'a', check: { op: 'called', endpointId: 'x', expect: 'any' } },
        {
          kind: 'simulation',
          name: 'b',
          check: { op: 'mutated', collection: 'c', expect: 'none' },
        },
      ]),
    );
    expect(mutants.map((m) => m.targets)).toEqual([0, 1]);
  });
});

describe('the gate stops refusing cases it cannot exercise', () => {
  it('leaves an unsupported check advisory rather than contradictory', () => {
    // A task_status check is graded against a run the builder never shaped for
    // it, so it failed the reference and the advisory "unproven" path became a
    // blocking refusal.
    const report = runDeterministicGate({
      expectations: parse([
        { kind: 'task_status', taskId: 'answer', status: 'succeeded' },
        {
          kind: 'simulation',
          name: 'called it',
          check: { op: 'called', endpointId: 'order_inspect', expect: 'any' },
        },
      ]),
    });
    expect(report.referencePasses, JSON.stringify(report.referenceFailures)).toBe(true);
    expect(report.unsupported).toContain('task_status');
    expect(report.unwitnessed).toEqual([]);
  });

  it('builds a reference that satisfies a positive reply pattern', () => {
    // Pasting the regex source produced a reply containing `PAY-\d`, which the
    // check correctly does not match — so a valid case was refused.
    const report = runDeterministicGate({
      expectations: parse([
        { kind: 'reply', name: 'cites a reference', check: { op: 'contains', pattern: 'PAY-\\d' } },
      ]),
    });
    expect(report.referencePasses, JSON.stringify(report.referenceFailures)).toBe(true);
    expect(report.unwitnessed).toEqual([]);
  });

  it('injects the forbidden write into the simulation the check is scoped to', () => {
    const report = runDeterministicGate({
      expectations: parse([
        {
          kind: 'simulation',
          simulationId: 'cs-desk',
          name: 'opened no case',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ]),
    });
    expect(report.referencePasses).toBe(true);
    expect(report.unwitnessed, 'the scoped writer must be visible to the check').toEqual([]);
  });
});
