/**
 * A hook that lets its broker refuse while the session is blocked must also be
 * able to restart it.
 *
 * `acquire` is keyed on the session or space id, never on the blocked flag, and
 * the flag is read through a lazy closure so nothing re-runs when it clears. A
 * consumer that gates without registering a resume therefore leaves its stream
 * idle for the life of the route, showing whatever it had before the expiry.
 *
 * This is a class rather than a case: the Coach broker was fixed in one of its two
 * consumers, and the other kept `isSessionExpired: () => false` — so it never
 * gated at all and retried against a session the server had stopped accepting.
 * Both failures are silent, and a suite covering one broker says nothing about the
 * next hook to acquire one.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

function productionHooks(): Array<{ name: string; src: string }> {
  return readdirSync(HOOKS_DIR)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
    .map((name) => ({ name, src: readFileSync(join(HOOKS_DIR, name), 'utf8') }));
}

/** A consumer acquires a broker; a broker defines the context it is handed. */
function isBrokerConsumer(name: string, src: string): boolean {
  return !name.endsWith('-broker.ts') && /\.acquire\(|\bacquire\(/.test(src);
}

describe('every broker consumer can restart what it gates', () => {
  it('registers a resume wherever it reports the session blocked', () => {
    const offenders = productionHooks()
      .filter(({ name, src }) => isBrokerConsumer(name, src))
      .filter(({ src }) => src.includes('isSessionExpired'))
      .filter(({ src }) => !src.includes('useResumeOnUnblock('))
      .map(({ name }) => name);

    expect(offenders, 'these hooks let a broker refuse while blocked but never restart it').toEqual(
      [],
    );
  });

  it('never hardcodes a session as live', () => {
    const offenders = productionHooks()
      .filter(({ src }) => src.includes('isSessionExpired: () => false'))
      .map(({ name }) => name);

    expect(
      offenders,
      'these hooks tell their broker the session can never expire, so it retries against a dead one',
    ).toEqual([]);
  });
});
