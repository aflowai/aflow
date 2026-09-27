/**
 * evaluateCriterion output-first field lookup.
 *
 * If the `contains` / `threshold` evaluators only read from
 * `data.metrics`, every taskCriterion that names an output field (e.g.
 * `validationScore`) scores 0 regardless of what the agent produced —
 * agents only write outputs (no `metrics` primitive exists at the
 * submit_output level), so an execute task writing
 * `validationScore: 0.835` still fails a `validation-produced`
 * criterion and the run verdict becomes fail (overall 0).
 *
 * Hence: `output` is the first lookup for named fields in taskCriteria
 * scope; `metrics` is the fallback.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { evaluateCriterion } from '../evalRunner.js';
import type { EvalCriterion } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

describe('evaluateCriterion — output-first field lookup', () => {
  describe('contains', () => {
    const baseCriterion: EvalCriterion = {
      name: 'validation-produced',
      type: 'contains',
      inField: 'validationScore',
      pattern: '^-?\\d+(\\.\\d+)?$',
    };

    it('reads from output when present (output-first precedence)', () => {
      const result = evaluateCriterion(baseCriterion, {
        output: { validationScore: 0.835 },
      });
      expect(result?.passed).toBe(true);
      expect(result?.score).toBe(1);
    });

    it('falls back to metrics when output lacks the field', () => {
      const result = evaluateCriterion(baseCriterion, {
        output: { unrelated: 'data' },
        metrics: { validationScore: 0.5 },
      });
      expect(result?.passed).toBe(true);
    });

    it('falls back to metrics when output is undefined (preserves pre-fix behavior for goal criteria)', () => {
      const result = evaluateCriterion(baseCriterion, {
        metrics: { validationScore: 0.5 },
      });
      expect(result?.passed).toBe(true);
    });

    it('prefers output over metrics when both contain the field', () => {
      const result = evaluateCriterion(
        {
          name: 'preferred',
          type: 'contains',
          inField: 'score',
          pattern: 'from-output',
        },
        {
          output: { score: 'from-output' },
          metrics: { score: 'from-metrics' },
        },
      );
      expect(result?.passed).toBe(true);
      expect(result?.evidence).toContain('matches');
    });

    it('treats output null as "absent" so metrics fallback wins', () => {
      // An agent that explicitly emits `validationScore: null` (allowed by
      // schema as type: ['number', 'null']) shouldn't shadow a real
      // metrics value if one exists at run-level.
      const result = evaluateCriterion(baseCriterion, {
        output: { validationScore: null },
        metrics: { validationScore: 0.7 },
      });
      expect(result?.passed).toBe(true);
    });

    it('still honors summary inField unchanged', () => {
      const result = evaluateCriterion(
        {
          name: 'summary-mentions',
          type: 'contains',
          inField: 'summary',
          pattern: 'ensemble',
        },
        { summary: 'soft-voting ensemble', output: { ignored: 'output' } },
      );
      expect(result?.passed).toBe(true);
    });

    it('fails (passed=false) when the named field is missing everywhere', () => {
      const result = evaluateCriterion(baseCriterion, {});
      expect(result?.passed).toBe(false);
      expect(result?.evidence).toContain('not found');
    });

    it('marks a missing-field result inapplicable so scoring excludes it (not a 0)', () => {
      const result = evaluateCriterion(baseCriterion, {});
      expect(result?.applicable).toBe(false);
    });

    it('leaves an applied-and-failed result applicable (a real 0)', () => {
      const result = evaluateCriterion(baseCriterion, {
        output: { validationScore: 'not-a-number' },
      });
      expect(result?.passed).toBe(false);
      expect(result?.score).toBe(0);
      expect(result?.applicable).toBeUndefined();
    });
  });

  describe('threshold', () => {
    const baseCriterion: EvalCriterion = {
      name: 'score-floor',
      type: 'threshold',
      metric: 'validationScore',
      operator: 'gte',
      target: 0.8,
    };

    it('reads from output when present', () => {
      const result = evaluateCriterion(baseCriterion, {
        output: { validationScore: 0.835 },
      });
      expect(result?.passed).toBe(true);
    });

    it('falls back to metrics when output lacks the metric', () => {
      const result = evaluateCriterion(baseCriterion, {
        metrics: { validationScore: 0.9 },
      });
      expect(result?.passed).toBe(true);
    });

    it('still fails when neither output nor metrics has the metric', () => {
      const result = evaluateCriterion(baseCriterion, {});
      expect(result?.passed).toBe(false);
    });

    it('marks a missing-metric result inapplicable (excluded from scoring)', () => {
      const result = evaluateCriterion(baseCriterion, {});
      expect(result?.applicable).toBe(false);
    });
  });
});
