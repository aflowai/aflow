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
 *
 * Undici's own fetch, not Node's: Node's is the undici it bundles, and it
 * refuses an Agent from another major (`invalid onRequestStart method`) —
 * which a hoisted copy of another version supplies — so every request failed
 * and read as a runtime not answering. A fetch and an Agent from one package
 * agree whatever Node bundles or the install hoists.
 */
import { Agent, fetch as undiciFetch } from 'undici';

const NO_TRANSPORT_LIMIT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function localRuntimeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    dispatcher: NO_TRANSPORT_LIMIT,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
