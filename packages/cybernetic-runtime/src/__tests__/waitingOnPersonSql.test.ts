/**
 * The SQL the run-gate and consent counts send (Plan 338 D2), checked as far
 * as it can be without Postgres.
 *
 * No Postgres SQL parser is among this repository's dependencies: no
 * `libpg-query`, `pgsql-ast-parser`, `node-sql-parser` or `@electric-sql/pglite`.
 * No Postgres server was available on the machine this suite was written on.
 * So nothing here proves that Postgres parses these queries or that they
 * return the numbers `waitingOnPersonGates.pg.test.ts` expects. That suite
 * proves both wherever DATABASE_URL names a migrated database, CI's included.
 * It makes a tenant schema of its own, so it needs no seeded tenant.
 *
 * What this suite proves is narrower. Each query renders, through drizzle's
 * own Postgres dialect, to the exact text and parameters the code sends. Every
 * placeholder is bound and every parameter used. Brackets and string literals
 * close. Each call that can throw on bad input sits behind its guard. The two
 * regex guards accept exactly what `decode` and `convert_from` accept, by
 * Node's own decoders.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BASE64_TEXT,
  CONSENT_RUNS_SQL,
  EGRESS_REQUESTS_SQL,
  PAUSED_SESSIONS_SQL,
  PAUSED_TASKS_SQL,
  SPACE_SLUG_SQL,
  UTF8_HEX,
} from '../waitingOnPerson.js';

const TENANT = 'a0000000-0000-4000-8000-000000000338';
const SPACE = '5e1d0000-0000-4000-8000-000000000338';

const QUERIES: Record<string, SQL> = {
  PAUSED_SESSIONS_SQL: PAUSED_SESSIONS_SQL(SPACE),
  PAUSED_TASKS_SQL: PAUSED_TASKS_SQL(SPACE),
  CONSENT_RUNS_SQL: CONSENT_RUNS_SQL(SPACE),
  EGRESS_REQUESTS_SQL: EGRESS_REQUESTS_SQL(TENANT, SPACE),
  SPACE_SLUG_SQL: SPACE_SLUG_SQL(SPACE),
};

const dialect = new PgDialect();

/** The text outside string literals, with each literal replaced by `''`. */
function outsideLiterals(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "'") {
      out += text[i];
      i++;
      continue;
    }
    let j = i + 1;
    for (;;) {
      if (j >= text.length) throw new Error(`Unclosed string literal at ${String(i)}`);
      if (text[j] === "'" && text[j + 1] === "'") j += 2;
      else if (text[j] === "'") break;
      else j++;
    }
    out += "''";
    i = j + 1;
  }
  return out;
}

function bracketDepths(text: string): { min: number; end: number } {
  let depth = 0;
  let min = 0;
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    min = Math.min(min, depth);
  }
  return { min, end: depth };
}

describe.each(Object.entries(QUERIES))('%s', (_name, query) => {
  const { sql: text, params } = dialect.sqlToQuery(query);
  const code = outsideLiterals(text);

  it('binds every placeholder and uses every parameter', () => {
    const used = new Set([...code.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect([...used].sort((a, b) => a - b)).toEqual(params.map((_p, i) => i + 1));
    expect(params).not.toContain(undefined);
  });

  it('closes every string literal and bracket', () => {
    expect(bracketDepths(code)).toEqual({ min: 0, end: 0 });
    expect(text).not.toMatch(/\[object Object\]|undefined|\$\{/);
  });

  it('casts to jsonb, decodes and converts only behind their guards', () => {
    const at = (pattern: RegExp) => code.search(pattern);
    if (/decode\(/.test(code)) {
      const guard = params.indexOf(BASE64_TEXT) + 1;
      expect(guard).toBeGreaterThan(0);
      expect(at(new RegExp(`~ \\$${String(guard)}\\b`))).toBeLessThan(at(/decode\(/));
    }
    if (/convert_from\(/.test(code)) {
      const guard = params.indexOf(UTF8_HEX) + 1;
      expect(guard).toBeGreaterThan(0);
      expect(at(new RegExp(`~ \\$${String(guard)}\\b`))).toBeLessThan(at(/convert_from\(/));
    }
    if (/::jsonb/.test(code)) {
      expect(at(/pg_input_is_valid\(/)).toBeGreaterThan(-1);
      expect(at(/pg_input_is_valid\(/)).toBeLessThan(at(/::jsonb/));
      expect(text).toContain(String.raw`strpos(d.t, '\u0000') = 0`);
    }
  });
});

describe('the regex guards', () => {
  const base64 = new RegExp(BASE64_TEXT);
  const utf8Hex = new RegExp(UTF8_HEX);

  it('take padded standard base64 and nothing else', () => {
    for (const bytes of ['', 'a', 'ab', 'abc', 'abcd', 'ÿþ?>']) {
      expect(base64.test(Buffer.from(bytes, 'latin1').toString('base64'))).toBe(true);
    }
    for (const text of ['not base64!', 'YQ', 'YWI', 'YW=I', 'YQ==YQ==', '-_8=', 'YW I=']) {
      expect(base64.test(text)).toBe(false);
    }
  });

  it('take well-formed UTF-8 with no NUL, and nothing else', () => {
    const fatal = new TextDecoder('utf-8', { fatal: true });
    const takes = (hex: string) => {
      try {
        return !fatal.decode(Buffer.from(hex, 'hex')).includes('\u0000');
      } catch {
        return false;
      }
    };
    const samples = [
      '',
      '7b7d',
      'c3a9',
      'e282ac',
      'f09f9880',
      'f48fbfbf',
      '00',
      'c0af',
      'c1bf',
      'e080af',
      'eda080',
      'f0808080',
      'f4908080',
      'f5808080',
      'ff',
      'c3',
      'e282',
      '80',
    ];
    for (const hex of samples) {
      expect({ hex, guard: utf8Hex.test(hex) }).toEqual({ hex, guard: takes(hex) });
    }
  });
});
