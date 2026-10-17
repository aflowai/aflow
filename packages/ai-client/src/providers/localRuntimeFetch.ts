/**
 * Every request to a model runtime on the operator's machine goes through this
 * fetch (Plan 323 §9 G5).
 *
 * Node's fetch abandons a response whose headers take five minutes and a body
 * silent for five. A local runtime sends no headers until it has read the
 * whole prompt, and nothing while it checks a downloaded layer's digest, and
 * on a laptop either outlasts five minutes — the cut surfaced as an
 * unreachable runtime, and every retry read the prompt again from the start.
 * The caller's signal is the only limit: the platform's idle window for a
 * local model on a turn, the lease on a download.
 */
import { Agent } from 'undici';

const NO_TRANSPORT_LIMIT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function localRuntimeFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, dispatcher: NO_TRANSPORT_LIMIT } as RequestInit);
}
