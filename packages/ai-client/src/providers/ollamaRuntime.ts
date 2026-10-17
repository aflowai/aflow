/**
 * The operator's actions on a local runtime's models, and what it has loaded
 * (Plan 323 D10). Separate from the adapter because these are not model calls:
 * nothing here generates, and nothing here is reachable by an agent.
 */
import { OLLAMA_DEFAULT_BASE_URL } from '@aflow/schemas';
import type { ProviderConfig } from '../types.js';
import { localRuntimeFetch } from './localRuntimeFetch.js';

/** Readiness asks this on every read; a runtime slower than this to say what it holds is reported unreachable. */
const STATUS_TIMEOUT_MS = 2_000;
/** Loading weights from disk takes tens of seconds to a few minutes (§9 G5). */
const LOAD_TIMEOUT_MS = 600_000;

export interface LoadedLocalModel {
  tag: string;
  sizeBytes: number;
  contextLength: number | null;
  expiresAt: string | null;
  /** `mlx` or `llamacpp`: the MLX runner ignores the window it was asked for, so it never reloads for a different one. */
  runner: string | null;
  /** The part of `sizeBytes` on the GPU; the rest runs on the CPU. */
  gpuBytes: number | null;
}

export interface InstalledLocalModel {
  tag: string;
  sizeBytes: number;
  digest: string;
  /** Set for a model the runtime forwards to its own cloud rather than running here. */
  remoteHost: string | null;
}

/** One line of a pull's progress, as the runtime streams it. */
export interface LocalPullProgress {
  status: string;
  completedBytes: number;
  totalBytes: number | null;
}

export interface LocalRuntimeClient {
  /** What the runtime holds now, or null when it does not answer. */
  loaded(): Promise<LoadedLocalModel[] | null>;
  /** Load a model at the window its requests will use, so the first one does not wait for it. */
  warm(tag: string, window: number, signal?: AbortSignal): Promise<void>;
  /** Unload a model, freeing its weights and every conversation's cache it holds. */
  unload(tag: string): Promise<void>;
  /** The runtime's version, or null when it does not answer. */
  version(): Promise<string | null>;
  /** What the runtime has downloaded, or null when it does not answer. */
  installed(): Promise<InstalledLocalModel[] | null>;
  /**
   * Download a model, reporting progress as the runtime streams it. Aborting
   * the signal closes the request, which installs nothing; the next pull of
   * the tag resumes from what was already downloaded (§9 G3).
   */
  pull(
    tag: string,
    onProgress: (progress: LocalPullProgress) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Delete a downloaded model. */
  remove(tag: string): Promise<void>;
}

export function localRuntimeClient(
  config: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'keepAlive'>,
): LocalRuntimeClient {
  const base = (config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
  const generate = async (
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await localRuntimeFetch(`${base}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    await res.text();
  };
  const read = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await localRuntimeFetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };
  return {
    async version() {
      return (await read<{ version?: string }>('/api/version'))?.version ?? null;
    },
    async installed() {
      const body = await read<{
        models?: Array<{ name?: string; size?: number; digest?: string; remote_host?: string }>;
      }>('/api/tags');
      if (body === null) return null;
      return (body.models ?? []).map((m) => ({
        tag: m.name ?? '',
        sizeBytes: m.size ?? 0,
        digest: m.digest ?? '',
        remoteHost: m.remote_host ?? null,
      }));
    },
    async pull(tag, onProgress, signal) {
      const res = await localRuntimeFetch(`${base}/api/pull`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: tag, stream: true }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
      const decoder = new TextDecoder();
      let buffer = '';
      let last = '';
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (chunk.error) throw new Error(chunk.error);
          last = chunk.status ?? last;
          onProgress({
            status: chunk.status ?? '',
            completedBytes: chunk.completed ?? 0,
            totalBytes: chunk.total ?? null,
          });
        }
      }
      // A stream the runtime closed early — a restart mid-pull — ends without
      // its `success` line, and installed nothing.
      if (last !== 'success') {
        throw new Error(`the download stopped before it finished (last: ${last || 'nothing'})`);
      }
    },
    async remove(tag) {
      const res = await localRuntimeFetch(`${base}/api/delete`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ model: tag }),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS * 5),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    },
    async loaded() {
      const body = await read<{
        models?: Array<{
          name?: string;
          size?: number;
          context_length?: number;
          expires_at?: string;
          runner?: string;
          size_vram?: number;
        }>;
      }>('/api/ps');
      if (body === null) return null;
      return (body.models ?? []).map((m) => ({
        tag: m.name ?? '',
        sizeBytes: m.size ?? 0,
        contextLength: m.context_length ?? null,
        expiresAt: m.expires_at ?? null,
        runner: m.runner ?? null,
        gpuBytes: m.size_vram ?? null,
      }));
    },
    warm: (tag, window, signal) =>
      generate(
        {
          model: tag,
          ...(config.keepAlive ? { keep_alive: config.keepAlive } : {}),
          options: { num_ctx: window },
        },
        LOAD_TIMEOUT_MS,
        signal,
      ),
    unload: (tag) => generate({ model: tag, keep_alive: 0 }, STATUS_TIMEOUT_MS * 5),
  };
}

/** The runtime's names for one model: a tag without a version is `:latest`. */
export function sameLocalTag(a: string, b: string): boolean {
  const full = (tag: string): string => (tag.includes(':') ? tag : `${tag}:latest`);
  return full(a) === full(b);
}

/**
 * Whether a request at `window` would be served by what is loaded, or would
 * load the model first. The llama.cpp runner reloads for a window other than
 * the one it holds; the MLX runner ignores the window and never does.
 */
export function servesWithoutLoading(
  loaded: readonly LoadedLocalModel[],
  tag: string,
  window: number,
): boolean {
  return loaded.some(
    (m) => sameLocalTag(m.tag, tag) && (m.runner === 'mlx' || m.contextLength === window),
  );
}
