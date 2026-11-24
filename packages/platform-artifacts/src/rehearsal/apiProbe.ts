/**
 * The route the rehearsal probes to decide the API answers at all. The server
 * registers it at the root, outside `/v1`, and a server-runtime test pins it
 * against the composed route table.
 */
export const REHEARSAL_HEALTH_PATH = '/health';

/**
 * Why the API at `apiUrl` cannot be rehearsed against, or null when it
 * answers its health route.
 */
export async function probeRehearsalApi(
  apiUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const health = await fetchImpl(`${apiUrl}${REHEARSAL_HEALTH_PATH}`);
    return health.ok
      ? null
      : `the API at ${apiUrl} answered ${String(health.status)} on ${REHEARSAL_HEALTH_PATH}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `the API at ${apiUrl} did not answer: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}`;
  }
}
