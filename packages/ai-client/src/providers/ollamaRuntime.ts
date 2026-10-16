/**
 * The operator's actions on a local runtime's models, and what it has loaded
 * (Plan 323 D10). Separate from the adapter because these are not model calls:
 * nothing here generates, and nothing here is reachable by an agent.
 */
import { OLLAMA_DEFAULT_BASE_URL } from '@aflow/schemas';
import type { ProviderConfig } from '../types.js';

/** Readiness asks this on every read; a runtime slower than this to say what it holds is reported unreachable. */
const STATUS_TIMEOUT_MS = 2_000;
/** Loading weights from disk takes tens of seconds to a few minutes (§9 G5). */
const LOAD_TIMEOUT_MS = 600_000;

export interface LoadedLocalModel {
  tag: string;
  sizeBytes: number;
  contextLength: number | null;
  expiresAt: string | null;
}

export interface LocalRuntimeClient {
  /** What the runtime holds now, or null when it does not answer. */
  loaded(): Promise<LoadedLocalModel[] | null>;
  /** Load a model at the window its requests will use, so the first one does not wait for it. */
  warm(tag: string, window: number): Promise<void>;
  /** Unload a model, freeing its weights and every conversation's cache it holds. */
  unload(tag: string): Promise<void>;
}

export function localRuntimeClient(
  config: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'keepAlive'>,
): LocalRuntimeClient {
  const base = (config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
  const generate = async (body: Record<string, unknown>, timeoutMs: number): Promise<void> => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    await res.text();
  };
  return {
    async loaded() {
      try {
        const res = await fetch(`${base}/api/ps`, {
          headers,
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          models?: Array<{
            name?: string;
            size?: number;
            context_length?: number;
            expires_at?: string;
          }>;
        };
        return (body.models ?? []).map((m) => ({
          tag: m.name ?? '',
          sizeBytes: m.size ?? 0,
          contextLength: m.context_length ?? null,
          expiresAt: m.expires_at ?? null,
        }));
      } catch {
        return null;
      }
    },
    warm: (tag, window) =>
      generate(
        {
          model: tag,
          ...(config.keepAlive ? { keep_alive: config.keepAlive } : {}),
          options: { num_ctx: window },
        },
        LOAD_TIMEOUT_MS,
      ),
    unload: (tag) => generate({ model: tag, keep_alive: 0 }, STATUS_TIMEOUT_MS * 5),
  };
}
