/**
 * The public web origin, resolved once for every process that needs to name a
 * URL a user will click.
 *
 * This exists because the value had accumulated four spellings —
 * `WEB_BASE_URL`, `APP_URL`, `NEXT_PUBLIC_BASE_URL`, `APP_BASE_URL` — read in
 * different combinations at each call site, with different fallbacks. A site
 * that fell back to localhost put `http://localhost:3001` into an agent's
 * system prompt in production, and the agent then told the user to go there.
 *
 * A wrong origin is not a cosmetic defect: it is what links in prompts, emails
 * and tool output point at. So in production a missing value throws rather
 * than degrading to a URL that cannot possibly be right.
 */

export const WEB_BASE_URL_ENV_KEYS = [
  'WEB_BASE_URL',
  'APP_URL',
  'NEXT_PUBLIC_BASE_URL',
  'APP_BASE_URL',
] as const;

const DEV_FALLBACK = 'http://localhost:3001';

function firstConfigured(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of WEB_BASE_URL_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Strips trailing slashes so callers can always append `/path`. */
function normalize(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Throws in production when none of the accepted variables is set. Callers on
 * a request path should resolve this at startup, not per request, so a
 * misconfiguration surfaces as a failed rollout.
 */
export function resolveWebBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = firstConfigured(env);
  if (configured) return normalize(configured);

  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      `No public web origin configured. Set ${WEB_BASE_URL_ENV_KEYS[0]} — it is used for links in agent prompts, emails, and tool output.`,
    );
  }

  return DEV_FALLBACK;
}

/**
 * Non-throwing variant for call sites that can legitimately omit a link — the
 * space-context navigation block, which is simply absent when unset.
 */
export function resolveWebBaseUrlOrNull(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = firstConfigured(env);
  if (configured) return normalize(configured);
  return env['NODE_ENV'] === 'production' ? null : DEV_FALLBACK;
}
