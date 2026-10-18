/**
 * `workflow.run.decide`: the first of ordered rules that holds over a state,
 * or the default where none does. The comparisons are a `when`'s, read over
 * `state.<path>` rather than one task's output, and the right side may name
 * another value of the state — a check run against the one a handoff recorded.
 */
import {
  predicateCombinator,
  predicateExpressions,
  type WorkflowRunDecideInput,
  type WorkflowRunDecideOutput,
  type WorkflowRunDecideRuleWhen,
} from '@aflow/schemas';
import type { ComparisonOp } from './graph.js';
import { parseOutputPath, readParsedOutputPath, type OutputPathSegment } from './outputPath.js';

export class RuleDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleDecisionError';
  }
}

type Operand =
  | { kind: 'path'; segments: OutputPathSegment[] }
  | { kind: 'literal'; value: string | number | boolean | null };

interface RuleComparison {
  left: OutputPathSegment[];
  op: ComparisonOp;
  right: Operand;
}

const OPERATOR = /(==|!=|>=|<=|>|<)/;
const STATE_PATH = /^state\.(.+)$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

function statePath(raw: string): OutputPathSegment[] | null {
  const match = STATE_PATH.exec(raw.trim());
  return match ? parseOutputPath(match[1]!) : null;
}

function operand(raw: string): Operand | null {
  const s = raw.trim();
  const path = statePath(s);
  if (path) return { kind: 'path', segments: path };
  const single = /^'([^']*)'$/.exec(s) ?? /^"([^"]*)"$/.exec(s);
  if (single) return { kind: 'literal', value: single[1]! };
  if (s === 'true' || s === 'false') return { kind: 'literal', value: s === 'true' };
  if (s === 'null') return { kind: 'literal', value: null };
  if (NUMBER.test(s)) return { kind: 'literal', value: Number(s) };
  return null;
}

/** One comparison, or null where it is outside the grammar. */
export function parseRuleComparison(expression: string): RuleComparison | null {
  const match = OPERATOR.exec(expression);
  if (!match) return null;
  const op = match[1] as ComparisonOp;
  const left = statePath(expression.slice(0, match.index));
  const right = operand(expression.slice(match.index + op.length));
  if (!left || !right) return null;
  return { left, op, right };
}

/** A missing value reads as null, so a rule can name a read that did not happen. */
function read(state: unknown, segments: OutputPathSegment[]): unknown {
  return readParsedOutputPath(state, segments) ?? null;
}

function holds(comparison: RuleComparison, state: unknown): boolean {
  const left = read(state, comparison.left);
  const right =
    comparison.right.kind === 'path'
      ? read(state, comparison.right.segments)
      : comparison.right.value;
  if (comparison.op === '==') return left === right;
  if (comparison.op === '!=') return left !== right;
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  switch (comparison.op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
}

function parsedRule(when: WorkflowRunDecideRuleWhen, index: number): RuleComparison[] {
  return predicateExpressions(when).map((expression) => {
    const parsed = parseRuleComparison(expression);
    if (!parsed) {
      throw new RuleDecisionError(
        `Rule ${String(index)} compares "${expression}", which is not one comparison of the form ` +
          '`state.<path> <op> <literal>` or `state.<path> <op> state.<path>`, with <op> one of ' +
          '==, !=, >, >=, <, <= and a literal a quoted string, a number, true, false or null.',
      );
    }
    return parsed;
  });
}

/**
 * Every rule is parsed before any is read, so a rule outside the grammar is
 * refused whatever the state, not only on the state that would reach it.
 */
export function decideByRules(input: WorkflowRunDecideInput): WorkflowRunDecideOutput {
  const rules = input.rules.map((rule, index) => ({
    rule,
    comparisons: parsedRule(rule.when, index),
  }));
  for (const [index, { rule, comparisons }] of rules.entries()) {
    const results = comparisons.map((comparison) => holds(comparison, input.state));
    const met =
      predicateCombinator(rule.when) === 'anyOf' ? results.some(Boolean) : results.every(Boolean);
    if (met) return { decision: rule.decision, reason: rule.reason, rule: index };
  }
  return { decision: input.otherwise.decision, reason: input.otherwise.reason, rule: null };
}
