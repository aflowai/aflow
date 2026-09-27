/**
 * Reconcile a requested output budget with what the model will actually emit.
 *
 * Thinking is paid for out of the SAME output budget as the answer, so a
 * request naming no ceiling inherits the provider's default — and on a
 * thinking-only model that default is spent reasoning, returning an empty
 * message with an ordinary stop reason rather than an error. The catalog
 * already records what each model emits, so it is the ceiling here too.
 */
export function resolveMaxOutputTokens(
  requested: number | undefined,
  modelMaxOutputTokens: number | undefined,
): number | undefined {
  // Outside the catalog there is nothing to reconcile against, so the caller
  // is trusted — the same trust the reasoning profile extends.
  if (modelMaxOutputTokens === undefined) return requested;
  if (requested === undefined) return modelMaxOutputTokens;
  return Math.min(requested, modelMaxOutputTokens);
}
