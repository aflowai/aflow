/**
 * The browser profiles belong to a paired machine, which only the local edition
 * has: the machine page renders them past its hosted-edition return, and they
 * reach the server only through the shared query hooks.
 *
 * Read from source, as the other edition guards are: the page pulls the
 * providers and the API client in behind it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(resolve(here, '../../screens/space-host-bindings.tsx'), 'utf8');
const SECTION = readFileSync(resolve(here, 'HostBrowserProfiles.tsx'), 'utf8');

describe('the browser profiles on the machine page', () => {
  it('render only past the hosted-edition return', () => {
    const gate = PAGE.indexOf("useEdition().id === 'enterprise'");
    const hostedReturn = PAGE.indexOf('if (isHostedEdition)');
    const rendered = PAGE.indexOf('<HostBrowserProfiles');
    expect(gate).toBeGreaterThan(-1);
    expect(hostedReturn).toBeGreaterThan(gate);
    expect(rendered).toBeGreaterThan(hostedReturn);
  });

  it('read and ask through the shared hooks, never fetch', () => {
    expect(SECTION).toContain('useApiQuery');
    expect(SECTION).toContain('useApiMutation');
    expect(SECTION).not.toMatch(/\bfetch\(/);
  });
});
