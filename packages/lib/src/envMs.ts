/**
 * Read a millisecond knob from the environment.
 *
 * Zero, a negative number and unparseable text all mean the same thing here —
 * the operator did not name a usable duration — so all three fall back rather
 * than producing a budget nothing can fit inside.
 */
export function positiveMsEnv(name: string, fallbackMs: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}
