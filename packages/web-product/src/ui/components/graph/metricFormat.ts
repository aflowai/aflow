/** Compact metric formatter — sub-1 scores keep precision; large values don't. */
export function fmtMetric(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2);
}
