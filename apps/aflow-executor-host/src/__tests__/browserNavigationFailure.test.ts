/**
 * Which refusal a failed navigation is reported as. One proxy serves every
 * run using a profile, so its log holds refusals made for other pages; only
 * one of a host this navigation asked for, directly or by redirect, explains it.
 */
import { describe, expect, it } from 'vitest';

import { harness, profile, refusal, RUN_A, RUN_B } from './fixtures/fakeBrowser.js';

const TIMEOUT = 'page.goto: Timeout 30000ms exceeded.';

describe('a failed navigation', () => {
  it('is not blamed on a host another run’s page was refused meanwhile', async () => {
    const h = harness({
      browsers: [profile({ rules: [{ origin: 'https://other.example', effect: 'deny' }] })],
      world: {
        redirects: new Map([['https://shop.example.com/out', 'https://other.example/']]),
        failures: new Map([['https://slow.example.com/', TIMEOUT]]),
        duringLoad: async (url) => {
          if (url !== 'https://slow.example.com/') return;
          const elsewhere = await refusal(
            h.driver.open({
              ...RUN_B,
              redelivered: false,
              profileId: 'default',
              url: 'https://shop.example.com/out',
            }),
          );
          expect(elsewhere.kind).toBe('origin_denied');
        },
      },
    });
    const { pageId } = await h.driver.open({
      ...RUN_A,
      redelivered: false,
      profileId: 'default',
      url: 'https://shop.example.com/',
    });

    const failed = await refusal(
      h.driver.navigate({
        ...RUN_A,
        pageId,
        to: { kind: 'url', url: 'https://slow.example.com/' },
        redelivered: false,
      }),
    );

    expect(h.proxies[0]?.refusals.map((r) => r.host)).toEqual(['other.example']);
    expect(failed.kind).toBe('navigation_failed');
    expect(failed.message).toBe(`https://slow.example.com/ did not load: ${TIMEOUT}`);
    expect(JSON.stringify({ message: failed.message, details: failed.details })).not.toContain(
      'other.example',
    );
  });

  it('reports its own error, not a subresource of the same page that was refused', async () => {
    const h = harness({
      browsers: [profile({ rules: [{ origin: 'https://tracker.example.net', effect: 'deny' }] })],
      world: {
        subresources: new Map([
          ['https://news.example.com/', ['https://tracker.example.net/p.gif']],
        ]),
        failures: new Map([['https://news.example.com/', TIMEOUT]]),
      },
    });
    const failed = await refusal(
      h.driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'default',
        url: 'https://news.example.com/',
      }),
    );

    expect(h.proxies[0]?.refusals.map((r) => r.host)).toEqual(['tracker.example.net']);
    expect(failed.kind).toBe('navigation_failed');
    expect(failed.message).toBe(`https://news.example.com/ did not load: ${TIMEOUT}`);
    expect(JSON.stringify(failed.details)).not.toContain('tracker');
  });

  it('is reported as the refusal when the host asked for was the one refused', async () => {
    const h = harness({ world: { localHosts: new Set(['intranet.example.com']) } });
    const { pageId } = await h.driver.open({
      ...RUN_A,
      redelivered: false,
      profileId: 'default',
      url: 'https://shop.example.com/',
    });

    const failed = await refusal(
      h.driver.navigate({
        ...RUN_A,
        pageId,
        to: { kind: 'url', url: 'https://intranet.example.com/' },
        redelivered: false,
      }),
    );

    expect(failed.kind).toBe('appliance_origin');
    expect(failed.details).toEqual({ host: 'intranet.example.com' });
    expect(failed.message).toContain('The connection was refused');
  });
});
