/**
 * Plan 333 D2: the rules for prose an agent reads, written once. Each placement
 * puts its own one-line lead-in above them. CLAUDE.md holds a literal copy.
 */
export const WRITING_STYLE_RULES = [
  '- No semicolons. Write two sentences.',
  '- Keep each sentence under about 25 words.',
  '- Use one verb, not a nominalisation: "analyse", not "perform an analysis of".',
  '- Use no soft phrasal verbs: "find", not "figure out".',
  '- Use no marketing adjectives.',
  '- Make each list item stand alone. Do not end one with "and" or "or".',
  '- Inside one unit, use one word per concept. Do not say "check", "validate" and "verify" for one action.',
  '- Keep every hedge. "May have pushed" stays "may have pushed".',
  '- Keep the present perfect where it carries meaning.',
].join('\n');
