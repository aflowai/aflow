import { describe, it, expect } from 'vitest';
import { CLERK_SPACE_DEFAULT, DEFAULT_CYBERNETIC_MODEL } from '@aflow/schemas';
import { resolveClerkModel } from '../clerkModel.js';
import type { StoredSessionMetadata } from '@aflow/database';
import {
  buildEvidenceEnvelope,
  decideSessionMetadataWork,
  nextSessionTitleState,
  SESSION_METADATA_EVIDENCE_CHARS,
  SESSION_METADATA_MAX_TURNS,
} from '../sessionMetadataGeneration.js';

describe('resolveClerkModel', () => {
  it('follows the space default provider, not the cheapest model on the board', () => {
    // A space running on Fireworks has a Fireworks key. Picking globally would
    // demand a credential nobody brought.
    const resolved = resolveClerkModel({ default: DEFAULT_CYBERNETIC_MODEL }, null);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(resolved.providerId).toBe('fireworks');
    expect(resolved.mode).toBe('auto');
    expect(resolved.modelRef).toBe('glm-flash');
    // The concrete version is recorded alongside the durable ref.
    expect(resolved.modelId).toContain('glm-5p3-flash');
  });

  it('moves with the space default when its provider changes', () => {
    const anthropic = resolveClerkModel({ default: 'sonnet' }, null);
    expect(anthropic.resolved && anthropic.providerId).toBe('anthropic');
    const google = resolveClerkModel({ default: 'pro' }, null);
    expect(google.resolved && google.providerId).toBe('google');
  });

  it('refuses to step over a tenant restriction to get something cheaper', () => {
    const resolved = resolveClerkModel({ default: DEFAULT_CYBERNETIC_MODEL }, [
      'glm-pro',
      'sonnet',
    ]);
    expect(resolved).toMatchObject({
      resolved: false,
      mode: 'auto',
      reason: 'not_permitted',
      providerId: 'fireworks',
    });
  });

  it('matches a tenant allowlist written in catalog ids against candidates named by alias', () => {
    // The spelling an admin's allowlist actually holds. Compared as strings
    // this reads as "not permitted" and the space keeps plain titles with a
    // message blaming a restriction its organization never made — which is
    // what it did, against the real dev tenant, on the first live run.
    const resolved = resolveClerkModel({ default: DEFAULT_CYBERNETIC_MODEL }, [
      'accounts/fireworks/models/glm-5p3',
      'accounts/fireworks/models/glm-5p3-flash',
      'claude-sonnet-5',
    ]);
    expect(resolved).toMatchObject({ resolved: true, mode: 'auto', modelRef: 'glm-flash' });
  });

  it('follows the next candidate when a tenant permits only that one', () => {
    // Google leads with flash-lite; a tenant permitting only flash gets flash
    // rather than nothing, and never a cheaper model it did not permit.
    const resolved = resolveClerkModel({ default: 'pro' }, ['gemini-3.8-flash', 'sonnet']);
    expect(resolved).toMatchObject({ resolved: true, modelRef: 'flash', providerId: 'google' });
  });

  it('takes an explicit assignment at face value', () => {
    const resolved = resolveClerkModel({ default: 'sonnet', clerk: 'flash-lite' }, null);
    expect(resolved).toMatchObject({ resolved: true, mode: 'explicit', providerId: 'google' });
  });

  it('asks for a correction rather than working around an unknown model', () => {
    const resolved = resolveClerkModel({ default: 'sonnet', clerk: 'a-model-that-retired' }, null);
    expect(resolved).toMatchObject({
      resolved: false,
      reason: 'unknown_model',
      requestedRef: 'a-model-that-retired',
    });
  });

  it('runs on the space default when someone chooses that', () => {
    const resolved = resolveClerkModel({ default: 'sonnet', clerk: CLERK_SPACE_DEFAULT }, null);
    expect(resolved).toMatchObject({
      resolved: true,
      mode: 'space_default',
      modelRef: 'sonnet',
      providerId: 'anthropic',
    });
  });
});

describe('evidence envelope', () => {
  const turn = (speaker: 'person' | 'agent', text: string) => ({ speaker, text });

  it('carries the opening request and the turns in reading order', () => {
    const { text, turnsIncluded, complete } = buildEvidenceEnvelope({
      openingRequest: 'Find the missing invoices',
      turns: [
        turn('person', 'Find the missing invoices'),
        turn('agent', 'Three are missing from the Stripe export.'),
      ],
      complete: true,
    });
    expect(turnsIncluded).toBe(2);
    expect(complete).toBe(true);
    expect(text).toContain('<opening-request>');
    expect(text.indexOf('Person: Find the missing')).toBeLessThan(
      text.indexOf('Agent: Three are missing'),
    );
  });

  it('keeps the recent end when the window binds, and says it was cut', () => {
    const turns = Array.from({ length: SESSION_METADATA_MAX_TURNS + 6 }, (_, i) =>
      turn(i % 2 === 0 ? 'person' : 'agent', `turn ${String(i)}`),
    );
    const { text, complete } = buildEvidenceEnvelope({
      openingRequest: 'turn 0',
      turns,
      complete: true,
    });
    expect(complete).toBe(false);
    expect(text).toContain('truncated="true"');
    // The end someone is waiting on survives; the middle is what goes.
    expect(text).toContain(`turn ${String(turns.length - 1)}`);
    expect(text).not.toContain('turn 3\n');
  });

  it('bounds one pasted log rather than letting it consume the envelope', () => {
    const { text } = buildEvidenceEnvelope({
      openingRequest: 'here is the log',
      turns: [turn('person', 'x'.repeat(50_000)), turn('agent', 'I read it.')],
      complete: true,
    });
    expect(text.length).toBeLessThanOrEqual(SESSION_METADATA_EVIDENCE_CHARS + 4_000);
    expect(text).toContain('Agent: I read it.');
  });

  it('reports partial coverage it was handed', () => {
    const { complete } = buildEvidenceEnvelope({
      openingRequest: null,
      turns: [turn('person', 'and the March ones?')],
      complete: false,
    });
    expect(complete).toBe(false);
  });
});

describe('what one pass is for', () => {
  const stored = (over: Partial<StoredSessionMetadata> = {}): StoredSessionMetadata => ({
    sessionId: 's',
    spaceId: 'sp',
    createdBy: null,
    executionAuthority: null,
    status: 'PAUSED',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    title: null,
    titleState: null,
    manualTitle: null,
    summary: null,
    summaryCoverage: null,
    metadataRevision: 0,
    metadataEvidenceRevision: null,
    metadataUpdatedAt: null,
    metadataEditedBy: null,
    record: {},
    ...over,
  });

  const ON = { summariesEnabled: true };
  const OFF = { summariesEnabled: false };

  it('asks for both on a conversation nothing has read yet', () => {
    expect(decideSessionMetadataWork(stored(), ON)).toEqual({ title: true, summary: true });
  });

  it('refines a provisional title, because no answer existed when it was written', () => {
    expect(
      decideSessionMetadataWork(stored({ title: 'Invoices', titleState: 'provisional' }), OFF),
    ).toEqual({ title: true, summary: false });
  });

  it('stops moving an established name', () => {
    // A name someone has learned to recognize is worth more than a marginally
    // better one, so the title freezes while the summary keeps up.
    expect(
      decideSessionMetadataWork(
        stored({ title: 'Missing invoices', titleState: 'established' }),
        ON,
      ),
    ).toEqual({ title: false, summary: true });
  });

  it('rewrites the summary at every reply, with no threshold of any kind', () => {
    // The failure this replaces: a summary spaced three exchanges apart said
    // "no game has started yet" while a game was in progress, and nothing on
    // screen said which turn it was describing.
    const settled = stored({
      title: 'Chess game setup',
      titleState: 'established',
      summary: 'No game has started yet.',
      record: {
        provenance: {
          modelRef: 'glm-flash',
          modelId: 'accounts/fireworks/models/glm-5p3-flash',
          providerId: 'fireworks',
          resolution: 'auto',
          promptVersion: 1,
          generatedAt: '2026-09-19T10:00:00.000Z',
          evidenceRevision: 4,
          coverage: 'full',
          exchangeCount: 4,
        },
      },
    });
    expect(decideSessionMetadataWork(settled, ON)).toEqual({ title: false, summary: true });
  });

  it('has nothing to do once the name is settled and the space wants no summaries', () => {
    expect(
      decideSessionMetadataWork(
        stored({ title: 'Missing invoices', titleState: 'established' }),
        OFF,
      ),
    ).toBeNull();
  });

  it('calls a title established only once an exchange stands behind it', () => {
    expect(nextSessionTitleState(0)).toBe('provisional');
    expect(nextSessionTitleState(1)).toBe('provisional');
    expect(nextSessionTitleState(2)).toBe('established');
  });
});
