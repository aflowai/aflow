/**
 * Contract: the coding agents a workspace can prefer are the ones its machines
 * publish, each marked with where it can start, so a preference that will fall
 * back reads as such before anyone picks it.
 */
import { describe, expect, it } from 'vitest';

import { describeAvailability, harnessChoices } from './HostCodingAgent.js';

describe('the coding agents a workspace can prefer', () => {
  it('lists each id once across machines, counting the machines that can start it', () => {
    const choices = harnessChoices([
      {
        hostname: 'laptop',
        harnesses: [
          { id: 'claude', label: 'Claude Code', installed: true },
          { id: 'codex', installed: false },
        ],
      },
      { hostname: 'desktop', harnesses: [{ id: 'codex', label: 'Codex', installed: true }] },
    ]);
    expect(choices).toEqual([
      { id: 'claude', label: 'Claude Code', installedOn: 1 },
      { id: 'codex', label: 'Codex', installedOn: 1 },
    ]);
    expect(describeAvailability(choices[1]!, 2)).toBe('installed on 1 of 2 machines');
  });

  it('says plainly when the one machine cannot start it', () => {
    const [codex] = harnessChoices([
      { hostname: 'laptop', harnesses: [{ id: 'codex', installed: false }] },
    ]);
    expect(describeAvailability(codex!, 1)).toBe('not installed on this computer');
  });
});
