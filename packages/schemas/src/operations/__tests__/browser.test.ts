import { describe, expect, it } from 'vitest';

import { bundleForOperation } from '../../catalog/capabilityBundles.js';
import { getAllOperations, getOperation } from '../../catalog/registry.js';
import { getStepTypeDescription } from '../../catalog/stepTypeDescriptions.js';
import {
  BROWSER_PAGE_ACT_OPERATION_ID,
  BROWSER_PAGE_NAVIGATE_OPERATION_ID,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BrowserPageActInputSchema,
  BrowserPageActOutputSchema,
  BrowserPageNavigateInputSchema,
  BrowserPageOpenInputSchema,
  BrowserPageOpenOutputSchema,
} from '../browser.js';
import {
  BROWSER_PAGE_CLOSE_OPERATION_ID,
  BROWSER_PAGE_LIST_OPERATION_ID,
  BROWSER_PAGE_READ_OPERATION_ID,
  BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
  BROWSER_PROFILE_LIST_OPERATION_ID,
  BrowserPageReadInputSchema,
  BrowserProfileListOutputSchema,
} from '../browserObservation.js';
import {
  BrowserProfileSchema,
  browserOriginPatternMatchesHost,
  browserOriginPatternMatchesUrl,
  parseBrowserOriginPattern,
} from '../browserProfile.js';

const BROWSER_OPS = () =>
  [...getAllOperations().values()].filter((op) => op.stepType === 'browser');

describe('the browser operations', () => {
  it('are registered under browser.page and browser.profile, in the browser bundle', () => {
    expect(
      BROWSER_OPS()
        .map((op) => op.operationId)
        .sort(),
    ).toEqual(
      [
        BROWSER_PAGE_ACT_OPERATION_ID,
        BROWSER_PAGE_CLOSE_OPERATION_ID,
        BROWSER_PAGE_LIST_OPERATION_ID,
        BROWSER_PAGE_NAVIGATE_OPERATION_ID,
        BROWSER_PAGE_OPEN_OPERATION_ID,
        BROWSER_PAGE_READ_OPERATION_ID,
        BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
        BROWSER_PROFILE_LIST_OPERATION_ID,
      ].sort(),
    );
    for (const op of BROWSER_OPS()) {
      expect(op.capabilityGroupId, op.operationId).toBe(
        op.operationId === BROWSER_PROFILE_LIST_OPERATION_ID ? 'browser.profile' : 'browser.page',
      );
      expect(bundleForOperation(op.operationId)?.id, op.operationId).toBe('browser');
      expect(op.outputZod, op.operationId).toBeDefined();
      expect(op.usage.pitfalls?.length, op.operationId).toBeGreaterThan(0);
    }
    expect(bundleForOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.tier).toBe('on_demand');
  });

  it('registers opening, moving and acting as writes that are never retried', () => {
    for (const id of [
      BROWSER_PAGE_OPEN_OPERATION_ID,
      BROWSER_PAGE_NAVIGATE_OPERATION_ID,
      BROWSER_PAGE_ACT_OPERATION_ID,
    ]) {
      const op = getOperation(id);
      expect(op?.accessMode, id).toBe('write');
      expect(op?.idempotency, id).toBe('non_idempotent');
      expect(op?.mutates, id).toBe(true);
      expect(op?.riskModifiers, id).toEqual(['external_side_effect']);
    }
  });

  it('holds every write but close to non-idempotent, so no interaction is ever replayed', () => {
    for (const op of BROWSER_OPS()) {
      if (op.accessMode !== 'write' || op.operationId === BROWSER_PAGE_CLOSE_OPERATION_ID) continue;
      expect(op.idempotency, op.operationId).toBe('non_idempotent');
    }
    expect(getOperation(BROWSER_PAGE_CLOSE_OPERATION_ID)).toMatchObject({
      accessMode: 'write',
      idempotency: 'idempotent',
    });
  });

  it('registers looking as reads', () => {
    for (const id of [
      BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
      BROWSER_PAGE_READ_OPERATION_ID,
      BROWSER_PAGE_LIST_OPERATION_ID,
      BROWSER_PROFILE_LIST_OPERATION_ID,
    ]) {
      expect(getOperation(id)).toMatchObject({
        accessMode: 'read',
        idempotency: 'idempotent',
        mutates: false,
      });
    }
  });

  it('tells the agent to reach for it last, what a page belongs to, and how actions fail', () => {
    const taught = (id: string): string => {
      const usage = getOperation(id)?.usage;
      return [...(usage?.whenToUse ?? []), ...(usage?.pitfalls ?? [])].join('\n');
    };
    expect(getOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.semanticDescription).toContain(
      'search.web.fetch',
    );
    expect(taught(BROWSER_PAGE_OPEN_OPERATION_ID)).toContain('page_gone');
    expect(taught(BROWSER_PAGE_ACT_OPERATION_ID)).toContain('uncertain_outcome');
    expect(taught(BROWSER_PAGE_ACT_OPERATION_ID)).toContain('outlineChanged: false');
    expect(taught(BROWSER_PAGE_ACT_OPERATION_ID)).toMatch(/no longer resolves/);
    expect(taught(BROWSER_PAGE_NAVIGATE_OPERATION_ID)).toContain('uncertain_outcome');
    expect(taught(BROWSER_PROFILE_LIST_OPERATION_ID)).toContain('sitesUnknown');
  });

  it('tells an agent, as data, that browser.profile.list says which sites hold a session', () => {
    expect(bundleForOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.hint).toContain(
      'browser.profile.list',
    );
    expect(getStepTypeDescription('browser')).toContain('browser.profile.list');
    expect(getOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.semanticDescription).toBeDefined();
  });
});

describe('browser.page.open', () => {
  it('opens http and https only, in the default profile unless one is named', () => {
    expect(BrowserPageOpenInputSchema.parse({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com',
      profileId: 'default',
    });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      expect(BrowserPageOpenInputSchema.safeParse({ url }).success).toBe(false);
    }
    expect(
      BrowserPageOpenInputSchema.safeParse({ url: 'https://example.com', profileId: '../x' })
        .success,
    ).toBe(false);
  });

  it('carries a census only when the outline was cut', () => {
    const base = {
      pageId: 'pg_1',
      url: 'https://example.com/',
      title: 'Example',
      outline: '- heading "Example" [level=1] [ref=e1]',
      receipt: {
        profileId: 'default',
        requestedUrl: 'https://example.com',
        redirected: false,
        outlineElements: 1,
        outlineCut: false,
      },
    };
    expect(BrowserPageOpenOutputSchema.parse(base)).not.toHaveProperty('outlineCensus');
    expect(
      BrowserPageOpenOutputSchema.parse({ ...base, outlineCensus: { link: 3 } }).outlineCensus,
    ).toEqual({
      link: 3,
    });
  });
});

describe('browser.page.navigate', () => {
  it('takes exactly one of url, back, forward, reload', () => {
    expect(BrowserPageNavigateInputSchema.safeParse({ pageId: 'p', back: true }).success).toBe(
      true,
    );
    expect(
      BrowserPageNavigateInputSchema.safeParse({ pageId: 'p', url: 'https://example.com' }).success,
    ).toBe(true);
    const none = BrowserPageNavigateInputSchema.safeParse({ pageId: 'p' });
    expect(none.error?.issues[0]?.message).toContain('Say where to go');
    const two = BrowserPageNavigateInputSchema.safeParse({
      pageId: 'p',
      url: 'https://example.com',
      reload: true,
    });
    expect(two.error?.issues[0]?.message).toContain('`url` and `reload`');
    expect(BrowserPageNavigateInputSchema.safeParse({ pageId: 'p', back: false }).success).toBe(
      false,
    );
  });
});

describe('browser.page.act', () => {
  it('takes the field each action needs, and refuses one that belongs to another', () => {
    const ok = [
      { action: 'click' },
      { action: 'hover' },
      { action: 'type', text: 'hello', submit: true },
      { action: 'select', values: ['red'] },
      { action: 'press', key: 'Enter' },
    ];
    for (const fields of ok) {
      expect(
        BrowserPageActInputSchema.safeParse({ pageId: 'p', ref: 'e1', ...fields }).success,
        fields.action,
      ).toBe(true);
    }
    const missing = BrowserPageActInputSchema.safeParse({ pageId: 'p', ref: 'e1', action: 'type' });
    expect(missing.error?.issues[0]?.message).toBe('`type` needs `text`.');
    const stray = BrowserPageActInputSchema.safeParse({
      pageId: 'p',
      ref: 'e1',
      action: 'click',
      key: 'Enter',
    });
    expect(stray.error?.issues[0]?.message).toContain('`key` belongs to `press`');
  });

  it('refuses a reference written as the outline prints it, saying what to send', () => {
    const wrapped = BrowserPageActInputSchema.safeParse({
      pageId: 'p',
      ref: '[ref=e12]',
      action: 'click',
    });
    expect(wrapped.error?.issues[0]?.message).toContain('such as `e12`');
  });

  it('records typed text by field and length, never by value', () => {
    const typed = BrowserPageActOutputSchema.shape.receipt.unwrap().shape.typed.unwrap().shape;
    expect(Object.keys(typed).sort()).toEqual(['characters', 'field', 'submitted']);
  });
});

describe('browser.page.read and browser.profile.list', () => {
  it('reads text, console or network, optionally filtered', () => {
    expect(
      BrowserPageReadInputSchema.safeParse({ pageId: 'p', what: 'console', contains: 'error' })
        .success,
    ).toBe(true);
    expect(BrowserPageReadInputSchema.safeParse({ pageId: 'p', what: 'cookies' }).success).toBe(
      false,
    );
  });

  it('lists sites by name only, or says why it cannot', () => {
    expect(
      BrowserProfileListOutputSchema.parse({
        profiles: [
          {
            profileId: 'default',
            posture: 'autonomous',
            window: 'hidden',
            running: false,
            sitesUnknown: 'not_started',
          },
        ],
      }).profiles[0],
    ).not.toHaveProperty('sites');
  });
});

describe('BrowserProfileSchema', () => {
  it('defaults everything but the id', () => {
    expect(BrowserProfileSchema.parse({ id: 'default' })).toEqual({
      id: 'default',
      spaces: 'all',
      posture: 'autonomous',
      rules: [],
      window: 'hidden',
      unattended: true,
      idleMinutes: 30,
    });
  });

  it('takes a list of spaces, origin rules and an idle limit', () => {
    const profile = BrowserProfileSchema.parse({
      id: 'work',
      spaces: ['space-a'],
      posture: 'read-only',
      rules: [
        { origin: 'https://mail.example.com', effect: 'deny' },
        { origin: '*.example.org', effect: 'allow' },
      ],
      window: 'visible',
      unattended: false,
      idleMinutes: 5,
    });
    expect(profile.spaces).toEqual(['space-a']);
    expect(profile.rules[0]?.effect).toBe('deny');
    expect(profile.idleMinutes).toBe(5);
    expect(BrowserProfileSchema.safeParse({ id: 'w', idleMinutes: 0 }).success).toBe(false);
  });

  it('refuses an id that is not a plain directory name', () => {
    for (const id of ['', '../escape', 'a/b', '.hidden', 'x'.repeat(65)]) {
      expect(BrowserProfileSchema.safeParse({ id }).success).toBe(false);
    }
  });

  it('refuses an origin pattern that is neither an exact origin nor a wildcard host, teaching both', () => {
    for (const origin of [
      'mail.example.com',
      'https://mail.example.com/inbox',
      'https://mail.example.com?x=1',
      'https://user@mail.example.com',
      '*example.com',
      '*.',
      'ftp://example.com',
      '*.exa mple.com',
    ]) {
      const parsed = BrowserProfileSchema.safeParse({
        id: 'a',
        rules: [{ origin, effect: 'deny' }],
      });
      expect(parsed.success, origin).toBe(false);
      expect(parsed.error?.issues[0]?.message, origin).toContain('`*.example.com`');
    }
    for (const origin of [
      'https://mail.example.com',
      'https://Mail.Example.com/',
      'http://localhost:5173',
      '*.example.com',
    ]) {
      expect(parseBrowserOriginPattern(origin), origin).toBeDefined();
    }
  });
});

describe('origin patterns', () => {
  const exact = parseBrowserOriginPattern('https://mail.example.com');
  const wild = parseBrowserOriginPattern('*.example.com');

  it('match an exact origin on scheme, host and port', () => {
    if (exact === undefined) throw new Error('pattern');
    expect(
      browserOriginPatternMatchesUrl(exact, new URL('https://mail.example.com/inbox?x=1')),
    ).toBe(true);
    expect(browserOriginPatternMatchesUrl(exact, new URL('https://MAIL.example.com:443/'))).toBe(
      true,
    );
    expect(browserOriginPatternMatchesUrl(exact, new URL('http://mail.example.com/'))).toBe(false);
    expect(browserOriginPatternMatchesUrl(exact, new URL('https://mail.example.com:8443/'))).toBe(
      false,
    );
    expect(browserOriginPatternMatchesHost(exact, 'mail.example.com.')).toBe(true);
  });

  it('match a wildcard on the host and every name under it, on any scheme and port', () => {
    if (wild === undefined) throw new Error('pattern');
    for (const url of [
      'https://example.com/',
      'http://a.example.com:8080/',
      'https://a.b.example.com/',
    ]) {
      expect(browserOriginPatternMatchesUrl(wild, new URL(url)), url).toBe(true);
    }
    for (const url of ['https://notexample.com/', 'https://example.com.evil.net/']) {
      expect(browserOriginPatternMatchesUrl(wild, new URL(url)), url).toBe(false);
    }
  });
});
