/**
 * Three words the product does not say to an operator.
 *
 * `harness` is the coding lane's name in the code; on screen the thing is a
 * coding agent, and where the machine reported which one it installed, that is
 * its name. `Shop` was one rail entry against `Store` everywhere else. `the
 * cybernetic agent` is the platform's own word for its ensemble; the operator
 * talks to Helmsman.
 */
export const BANNED_OPERATOR_WORDS: ReadonlyArray<{ pattern: RegExp; instead: string }> = [
  { pattern: /\bharness(es)?\b/i, instead: 'coding agent, or the agent’s own label' },
  { pattern: /\bshop\b/i, instead: 'Store' },
  { pattern: /\bcybernetic agent\b/i, instead: 'Helmsman' },
];
