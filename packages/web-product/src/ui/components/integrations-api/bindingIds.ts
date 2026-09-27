/** The first free connection id: `${apiId}-default`, else `${apiId}-2`, `-3`, … */
export function nextFreeBindingId(apiId: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  const base = `${apiId}-default`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${apiId}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A legible default name mirroring the free id's suffix (`acme connection 2`). */
export function defaultBindingName(apiId: string, freeBindingId: string): string {
  const m = /-(\d+)$/.exec(freeBindingId);
  return m ? `${apiId} connection ${m[1]}` : `${apiId} connection`;
}
