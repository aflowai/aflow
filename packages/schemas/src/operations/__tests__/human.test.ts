import { describe, expect, it } from 'vitest';
import {
  HumanActionCenterFocusInputSchema,
  HumanChatAskInputSchema,
  HumanChatAskOutputSchema,
  HumanOperationRegistrations,
} from '../human.js';
import { getOperation } from '../../catalog/registry.js';

describe('HumanChatAskInputSchema discriminator', () => {
  it('accepts a minimal input-kind request with a prompt', () => {
    const parsed = HumanChatAskInputSchema.parse({
      kind: 'input',
      prompt: 'Which dataset should I analyse?',
    });
    expect(parsed.kind).toBe('input');
    expect(parsed.prompt).toBe('Which dataset should I analyse?');
  });

  it('rejects input-kind without a prompt', () => {
    const result = HumanChatAskInputSchema.safeParse({ kind: 'input' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toMatch(/prompt.*required/i);
    }
  });

  it('accepts an approval-kind request with title + description', () => {
    const parsed = HumanChatAskInputSchema.parse({
      kind: 'approval',
      title: 'Deploy to production?',
      description: 'Promote v2.3.0 to prod.',
    });
    expect(parsed.kind).toBe('approval');
    expect(parsed.title).toBe('Deploy to production?');
    expect(parsed.description).toBe('Promote v2.3.0 to prod.');
  });

  it('rejects approval-kind without a title', () => {
    const result = HumanChatAskInputSchema.safeParse({
      kind: 'approval',
      description: 'A description without a title.',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toMatch(/title.*required/i);
    }
  });

  it('rejects approval-kind without a description', () => {
    const result = HumanChatAskInputSchema.safeParse({
      kind: 'approval',
      title: 'Title only',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toMatch(/description.*required/i);
    }
  });

  it('accepts the rich uiHints shape (mode + labels)', () => {
    const parsed = HumanChatAskInputSchema.parse({
      kind: 'input',
      prompt: 'Pick one',
      inputSchema: { type: 'string', enum: ['a', 'b', 'c'] },
      uiHints: { mode: 'choices', submitLabel: 'Use this', placeholder: '…' },
    });
    expect(parsed.uiHints?.mode).toBe('choices');
  });
});

describe('HumanActionCenterFocusInputSchema', () => {
  it('accepts a minimal {itemId} call (Plan 166 §HITL — placement removed)', () => {
    const parsed = HumanActionCenterFocusInputSchema.parse({ itemId: 'proposal:abc' });
    expect(parsed.itemId).toBe('proposal:abc');
  });

  it('rejects an empty itemId', () => {
    expect(() => HumanActionCenterFocusInputSchema.parse({ itemId: '' })).toThrow();
  });

  it('caps the reason copy at 280 chars', () => {
    expect(() =>
      HumanActionCenterFocusInputSchema.parse({
        itemId: 'proposal:x',
        reason: 'r'.repeat(281),
      }),
    ).toThrow();
  });

  it('rejects a bare UUID (no prefix) with a teaching error message', () => {
    // Regression for the hallucinated-id case: agents sometimes pass
    // raw UUIDs they invented rather than listing-op ids. The Zod
    // error becomes the FAILED tool result's message, so it must read
    // as actionable guidance, not just a schema dump.
    const result = HumanActionCenterFocusInputSchema.safeParse({
      itemId: '4ebbe8e1-6ed0-4300-aec2-2e2c570eb10e',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? '';
      expect(msg).toContain('proposal.list');
      expect(msg).toContain('human.chat.ask');
    }
  });

  it('accepts each documented prefix verbatim', () => {
    for (const id of ['proposal:abc', 'step:abc', 'gate:abc', 'settings:abc']) {
      expect(() => HumanActionCenterFocusInputSchema.parse({ itemId: id })).not.toThrow();
    }
  });
});

describe('HumanChatAskOutputSchema — Phase 5b review P1', () => {
  // The runtime path produces the *raw* resume payload here (no
  // wrapper) — `applyStepSucceeded` attributes the child user.interaction.*
  // step's output directly to the human.chat.ask tool call.
  it('accepts a raw UserInputResumePayload (kind="input" tool result)', () => {
    const parsed = HumanChatAskOutputSchema.parse({
      input: 'sales',
      providedAt: new Date().toISOString(),
      providedBy: 'user-abc',
    });
    expect(parsed).toMatchObject({ input: 'sales' });
  });

  it('accepts a raw UserApprovalResumePayload (kind="approval" tool result)', () => {
    const parsed = HumanChatAskOutputSchema.parse({
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      decidedBy: 'user-abc',
    });
    expect(parsed).toMatchObject({ decision: 'approved' });
  });

  it('rejects the legacy `{ kind, response }` wrapper that the runtime never produced', () => {
    const result = HumanChatAskOutputSchema.safeParse({
      kind: 'input',
      response: {
        input: 'sales',
        providedAt: new Date().toISOString(),
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('Catalog registration', () => {
  it('registers two human.* operations', () => {
    const ids = HumanOperationRegistrations.map((r) => `${r.stepType}.${r.group}.${r.verb}`);
    expect(ids).toContain('human.chat.ask');
    expect(ids).toContain('human.action_center.focus');
  });

  it('exposes human.chat.ask as a write op', () => {
    const op = getOperation('human.chat.ask');
    expect(op).toBeDefined();
    expect(op?.accessMode).toBe('write');
    expect(op?.mutates).toBe(true);
  });

  it('exposes human.action_center.focus as a read op (no pause, no side effect on the DB)', () => {
    const op = getOperation('human.action_center.focus');
    expect(op).toBeDefined();
    expect(op?.accessMode).toBe('read');
    expect(op?.mutates).toBe(false);
  });
});
