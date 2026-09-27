/**
 * No route builds an externally-visible origin out of the incoming request.
 *
 * Fastify derives `hostname` from the `Host` header and prefers
 * `X-Forwarded-Host` behind a proxy, so both are caller-controlled. A URL built
 * from them — a webhook ingest URL, an A2A agent card, the `baseUrl` a session
 * embeds in its own links — is handed back to the client as an address the
 * platform issued, aimed wherever the caller pointed the header. Every such
 * origin comes from `resolveApiBaseUrl()`, which reads configuration only.
 *
 * The check is textual, so it catches the shape that keeps reappearing and
 * nothing else: destructuring the same properties, or reading the raw `Host`
 * header, passes it. Widen it when one of those shows up, and keep any
 * exception here with its reason rather than loosening the match.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ → routes
const ROUTES_DIR = join(__dirname, '..');
const ROUTES_REL = 'packages/server-runtime/src/routes';

/** This guard names the properties it bans, so it cannot scan itself. */
const SELF = basename(fileURLToPath(import.meta.url));

const REQUEST_ORIGIN_PROPERTY = /\b(?:request|req)\.(?:protocol|hostname)\b/;

function tsFilesUnder(dir: string, relPrefix: string): { rel: string; abs: string }[] {
  const found: { rel: string; abs: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...tsFilesUnder(abs, rel));
    else if (entry.name.endsWith('.ts') && entry.name !== SELF) found.push({ rel, abs });
  }
  return found;
}

describe('canonical origin', () => {
  it('no route file reads the request-derived protocol or hostname', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(ROUTES_DIR, ROUTES_REL)) {
      const lines = readFileSync(file.abs, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (REQUEST_ORIGIN_PROPERTY.test(line)) offenders.push(`${file.rel}:${index + 1}`);
      });
    }
    expect(offenders, 'build the origin with resolveApiBaseUrl() instead').toEqual([]);
  });

  it('scans the whole route tree, not just its top level', () => {
    const scanned = tsFilesUnder(ROUTES_DIR, ROUTES_REL).map((f) => f.rel);
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.some((rel) => rel.split('/').length > ROUTES_REL.split('/').length + 1)).toBe(
      true,
    );
  });
});
