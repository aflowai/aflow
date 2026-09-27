/**
 * On-demand provider key verification — a cheap authenticated read per
 * provider (models list / key info), never a token-spending generation.
 */

export const VERIFIABLE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'fireworks',
  'openrouter',
  'xai',
  'typesafe',
] as const;
export type VerifiableProvider = (typeof VERIFIABLE_PROVIDERS)[number];

export type VerifyOutcome =
  | { supported: false }
  | { supported: true; ok: true }
  | { supported: true; ok: false; errorCode: string; message: string };

export function isVerifiableProvider(providerId: string): providerId is VerifiableProvider {
  return (VERIFIABLE_PROVIDERS as readonly string[]).includes(providerId);
}

const VERIFY_TIMEOUT_MS = 10_000;

interface Probe {
  url: (secrets: Record<string, string>, config: Record<string, string>) => string;
  headers: (
    secrets: Record<string, string>,
    config: Record<string, string>,
  ) => Record<string, string>;
}

const PROBES: Record<VerifiableProvider, Probe> = {
  openai: {
    url: () => 'https://api.openai.com/v1/models',
    headers: (secrets, config) => ({
      Authorization: `Bearer ${secrets['api_key'] ?? ''}`,
      ...(config['org_id'] ? { 'OpenAI-Organization': config['org_id'] } : {}),
    }),
  },
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/models',
    headers: (secrets) => ({
      'x-api-key': secrets['api_key'] ?? '',
      'anthropic-version': '2023-06-01',
    }),
  },
  google: {
    url: (secrets) =>
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(secrets['api_key'] ?? '')}`,
    headers: () => ({}),
  },
  fireworks: {
    url: () => 'https://api.fireworks.ai/inference/v1/models',
    headers: (secrets) => ({ Authorization: `Bearer ${secrets['api_key'] ?? ''}` }),
  },
  openrouter: {
    url: () => 'https://openrouter.ai/api/v1/key',
    headers: (secrets) => ({ Authorization: `Bearer ${secrets['api_key'] ?? ''}` }),
  },
  xai: {
    url: () => 'https://api.x.ai/v1/models',
    headers: (secrets) => ({ Authorization: `Bearer ${secrets['api_key'] ?? ''}` }),
  },
  typesafe: {
    url: () => 'https://api.typesafe.ai/v1/models',
    headers: (secrets) => ({ Authorization: `Bearer ${secrets['api_key'] ?? ''}` }),
  },
};

export async function verifyProviderKey(
  providerId: string,
  secrets: Record<string, string>,
  config: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyOutcome> {
  if (!isVerifiableProvider(providerId)) return { supported: false };
  const probe = PROBES[providerId];

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, VERIFY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(probe.url(secrets, config), {
      method: 'GET',
      headers: probe.headers(secrets, config),
      signal: controller.signal,
    });
    if (res.ok) return { supported: true, ok: true };
    return {
      supported: true,
      ok: false,
      errorCode: String(res.status),
      message:
        res.status === 401 || res.status === 403
          ? 'The key was rejected by the provider.'
          : `Provider returned HTTP ${res.status}.`,
    };
  } catch (err) {
    return {
      supported: true,
      ok: false,
      errorCode: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error',
      message: 'Could not reach the provider to verify the key.',
    };
  } finally {
    clearTimeout(timer);
  }
}
