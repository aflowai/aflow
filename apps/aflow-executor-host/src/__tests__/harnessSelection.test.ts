/**
 * Contract: a run does not have to know the harness id. A run that names none
 * gets the machine's default, and the first configured harness that is
 * installed when the default is not — so installing a second harness never
 * turns a skill that names none into a refusal. A named harness is that harness
 * or a refusal, never another one.
 */
import { describe, expect, it } from 'vitest';

import { HostHarnessRunInputSchema } from '@aflow/schemas';

import { harnessTurnArgv, selectHarness } from '../handlers/harnessHandlers.js';
import { buildHarnessArgv, HarnessProfileError, HarnessProfileSchema } from '../harnessProfiles.js';
import type { HarnessProfile } from '../harnessProfiles.js';

function profile(id: string): HarnessProfile {
  return HarnessProfileSchema.parse({ id, executable: `/usr/local/bin/${id}` });
}

function profiles(...ids: string[]): ReadonlyMap<string, HarnessProfile> {
  return new Map(ids.map((id) => [id, profile(id)]));
}

/** A machine where exactly these harnesses are installed. */
function installed(...ids: string[]): (executable: string) => Promise<boolean> {
  return async (executable) => ids.some((id) => executable === `/usr/local/bin/${id}`);
}

const WITH_MODEL = HarnessProfileSchema.parse({
  id: 'claude',
  executable: '/usr/local/bin/claude',
  modelArgs: ['--model', '{model}'],
  model: 'fable',
});

describe('choosing a harness', () => {
  it('uses the only one offered when the call named none and no default is set', async () => {
    const selection = await selectHarness(
      profiles('claude'),
      undefined,
      undefined,
      installed('claude'),
    );
    expect(selection.profile.id).toBe('claude');
    expect(selection.selectedBy).toBe('default');
  });

  it("runs the machine's default when several are offered", async () => {
    const selection = await selectHarness(
      profiles('claude', 'codex'),
      undefined,
      'codex',
      installed('claude', 'codex'),
    );
    expect(selection.profile.id).toBe('codex');
    expect(selection.selectedBy).toBe('default');
    expect(selection.passedOver).toBeUndefined();
  });

  it('falls back to the first installed harness, saying why, when the default is not installed', async () => {
    const selection = await selectHarness(
      profiles('claude', 'codex'),
      undefined,
      'claude',
      installed('codex'),
    );
    expect(selection.profile.id).toBe('codex');
    expect(selection.selectedBy).toBe('fallback');
    expect(selection.passedOver).toContain('`claude` is not installed');
  });

  it('falls back in policy order when several are offered and no default is set', async () => {
    const selection = await selectHarness(
      profiles('opencode', 'claude'),
      undefined,
      undefined,
      installed('opencode', 'claude'),
    );
    expect(selection.profile.id).toBe('opencode');
    expect(selection.selectedBy).toBe('fallback');
    expect(selection.passedOver).toContain('no default harness is set');
  });

  it('falls back when the default names a harness that is not configured', async () => {
    const selection = await selectHarness(
      profiles('claude'),
      undefined,
      'codex',
      installed('claude'),
    );
    expect(selection.profile.id).toBe('claude');
    expect(selection.selectedBy).toBe('fallback');
    expect(selection.passedOver).toContain('`codex` is not configured');
  });

  it('runs a named harness that is not the default, and never swaps an unknown one', async () => {
    const available = profiles('claude', 'codex');
    const named = await selectHarness(available, 'claude', 'codex', installed('codex'));
    expect(named.profile.id).toBe('claude');
    expect(named.selectedBy).toBe('named');
    await expect(selectHarness(available, 'amp', 'codex', installed('codex'))).rejects.toThrow(
      HarnessProfileError,
    );
  });

  it('says none are configured rather than reporting an empty choice', async () => {
    try {
      await selectHarness(profiles(), undefined, undefined, installed());
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('No coding harness is configured');
      expect((error as HarnessProfileError).kind).toBe('unknown_profile');
    }
  });

  it('brings the chosen profile model with it, which a run model still overrides', async () => {
    const selection = await selectHarness(
      new Map([['claude', WITH_MODEL]]),
      undefined,
      undefined,
      installed('claude'),
    );
    expect(buildHarnessArgv(selection.profile, 't')).toContain('fable');
    const overridden = buildHarnessArgv(selection.profile, 't', [], undefined, 'parable');
    expect(overridden).toContain('parable');
    expect(overridden).not.toContain('fable');

    const unnamed = HostHarnessRunInputSchema.parse({ bindingId: 'hb_project', task: 't' });
    const fromProfile = harnessTurnArgv(selection.profile, unnamed, 't', 'conversation-1', false);
    expect(
      fromProfile.slice(fromProfile.indexOf('--model'), fromProfile.indexOf('--model') + 2),
    ).toEqual(['--model', 'fable']);
  });
});
