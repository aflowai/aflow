import { describe, expect, it } from 'vitest';

import { bundleForOperation } from '../../catalog/capabilityBundles.js';
import { getOperation } from '../../catalog/registry.js';
import {
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BrowserPageOpenInputSchema,
  BrowserPageOpenOutputSchema,
} from '../browser.js';
import { BrowserProfileSchema } from '../browserProfile.js';

describe('browser.page.open', () => {
  it('is registered under the browser.page capability group', () => {
    expect(BROWSER_PAGE_OPEN_OPERATION_ID).toBe('browser.page.open');
    const op = getOperation(BROWSER_PAGE_OPEN_OPERATION_ID);
    expect(op?.stepType).toBe('browser');
    expect(op?.capabilityGroupId).toBe('browser.page');
    expect(op?.accessMode).toBe('read');
    expect(op?.riskModifiers).toEqual(['external_side_effect']);
    expect(bundleForOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.id).toBe('browser');
    expect(bundleForOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.tier).toBe('on_demand');
  });

  it('tells the agent to reach for it last, and that a page belongs to its run', () => {
    const usage = getOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.usage;
    const taught = [...(usage?.whenToUse ?? []), ...(usage?.pitfalls ?? [])].join('\n');
    expect(taught).toContain('search.web.fetch');
    expect(taught).toMatch(/API or MCP/);
    expect(taught).toContain('page_gone');
    expect(taught).toMatch(/restarts/);
  });

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
    ).toEqual({ link: 3 });
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
    });
  });

  it('takes a list of spaces and origin rules', () => {
    const profile = BrowserProfileSchema.parse({
      id: 'work',
      spaces: ['space-a'],
      posture: 'read-only',
      rules: [{ origin: 'https://mail.example.com', effect: 'deny' }],
      window: 'visible',
      unattended: false,
    });
    expect(profile.spaces).toEqual(['space-a']);
    expect(profile.rules[0]?.effect).toBe('deny');
  });

  it('refuses an id that is not a plain directory name', () => {
    for (const id of ['', '../escape', 'a/b', '.hidden', 'x'.repeat(65)]) {
      expect(BrowserProfileSchema.safeParse({ id }).success).toBe(false);
    }
  });
});
