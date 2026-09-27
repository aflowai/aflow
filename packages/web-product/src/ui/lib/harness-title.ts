/**
 * What a coding-agent run is called on screen.
 *
 * `harness` is the lane's name in the code and no operator's word for anything,
 * so nothing on screen says it. What the operator installed is the title — a
 * machine can offer several — and the lane is the muted word beside it, which
 * leaves two runs on one machine told apart by name.
 *
 * The operator's own word for it is preferred over the id wherever one is
 * carried: `Claude Code` is what they installed, `claude` is what the profile
 * calls it. A finished run names its own agent on the result, so the label
 * arrives with the answer and needs no second read; a running one has only the
 * id its input named.
 *
 * Its own module because both the live card and the completed one are titled by
 * it, and they import each other's halves already.
 */
export interface HarnessCardTitle {
  title: string;
  /** The muted word beside the title, absent when the title is already it. */
  lane: string | undefined;
}

/** A harness as something names it — an id, and the operator's word for it. */
export interface HarnessName {
  id?: string | undefined;
  label?: string | undefined;
}

export function harnessCardTitle(opts: {
  /**
   * The harness the result named, where the run finished and said so. Preferred
   * over the input's id, because this is the half that carries the label.
   */
  reported?: HarnessName | undefined;
  /** The harness id the step input named — all a running card can read. */
  harness?: string | undefined;
  folder?: string | undefined;
  continued?: boolean | undefined;
}): HarnessCardTitle {
  const named = firstNamed(opts.reported?.label, opts.reported?.id, opts.harness);
  const title = named ?? 'Coding agent';
  // A run nothing named is titled by its lane, so repeating the lane beside it
  // would say the same word twice; a continued one adds what the title cannot.
  const lane =
    opts.continued === true
      ? 'continued session'
      : named === undefined
        ? undefined
        : 'coding agent';
  return { title: opts.folder !== undefined ? `${title} · ${opts.folder}` : title, lane };
}

function firstNamed(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed !== '') return trimmed;
  }
  return undefined;
}

/**
 * Which harness a step was given, as its recorded input spells it.
 *
 * The id is optional there — a machine offering exactly one harness resolves an
 * omitted id itself — so absence is ordinary, and a card that reads nothing
 * falls back to naming the lane.
 */
export function readHarnessId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)['harness'];
  if (typeof value !== 'string') return undefined;
  return firstNamed(value);
}

/**
 * Which harness a finished run says it used.
 *
 * Read off the payload rather than trusted from its type: a result stored
 * before results named their harness carries no such field, and a card titled
 * by the id its input already gave is the right answer for one.
 */
export function readResultHarness(result: unknown): HarnessName | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const value = (result as Record<string, unknown>)['harness'];
  if (value === null || typeof value !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  const id = typeof fields['id'] === 'string' ? firstNamed(fields['id']) : undefined;
  const label = typeof fields['label'] === 'string' ? firstNamed(fields['label']) : undefined;
  if (id === undefined && label === undefined) return undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}
