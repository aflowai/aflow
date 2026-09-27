/**
 * What an agent may do when nobody is there.
 *
 * The first scheduled run ever fired parked on `input_required` and would have
 * sat there until its hot state aged out. Nothing was broken: the assistant is
 * the conversation handler, and pausing is what a conversation handler does —
 * a conversation is not finished, only quiet, and the person resumes when they
 * like. Started by a schedule, there is no person, and the same correct
 * behaviour becomes a question asked into an empty room.
 */
import { describe, expect, it } from 'vitest';

import { isPauseForInputAllowed, resolveAgentPolicies } from '../agentTurn.js';
import { isUnattendedTrigger, resolveAgentPoliciesFromConfig } from '../agentPolicies.js';

describe('an assistant with somebody there', () => {
  it('keeps the conversation open, which is its job', () => {
    const policies = resolveAgentPolicies({
      agentRole: 'assistant',
      requestInputPolicy: undefined,
      completionPolicy: undefined,
    });
    expect(policies.requestInputPolicy).toBe('allowed');
    expect(policies.completionPolicy).toBe('open_ended');
    expect(isPauseForInputAllowed(policies.requestInputPolicy)).toBe(true);
  });
});

describe('an assistant with nobody there', () => {
  it('takes the terminal shape instead — finish, or say what stopped it', () => {
    const policies = resolveAgentPolicies({
      agentRole: 'assistant',
      requestInputPolicy: undefined,
      completionPolicy: undefined,
      unattended: true,
    });
    expect(policies.completionPolicy).toBe('must_complete_or_block');
    // Withheld rather than discouraged: the function is not offered at all, so
    // there is no prose for a model to weigh against its own judgement.
    expect(isPauseForInputAllowed(policies.requestInputPolicy)).toBe(false);
  });

  it('overrides a standing configuration that says otherwise', () => {
    // The assistant's own definition sets `allowed`, because that describes a
    // conversation with somebody in it. Treated as a considered statement about
    // unattended runs it wins silently and the agent parks — which is what the
    // first version of this did, and the scheduled run paused anyway.
    const policies = resolveAgentPolicies({
      agentRole: 'assistant',
      requestInputPolicy: 'allowed',
      completionPolicy: 'open_ended',
      unattended: true,
    });
    expect(policies.requestInputPolicy).toBe('never');
    expect(policies.completionPolicy).toBe('must_complete_or_block');
  });

  it('changes nothing for a subagent, which already terminates', () => {
    const attended = resolveAgentPolicies({
      agentRole: 'subagent',
      requestInputPolicy: undefined,
      completionPolicy: undefined,
    });
    const alone = resolveAgentPolicies({
      agentRole: 'subagent',
      requestInputPolicy: undefined,
      completionPolicy: undefined,
      unattended: true,
    });
    expect(alone).toEqual(attended);
    // `blocked_only` survives on purpose: a subagent that is genuinely stuck
    // reports upward to a parent that is still running, which is a different
    // thing from asking a human who is not there.
    expect(alone.requestInputPolicy).toBe('blocked_only');
  });
});

/**
 * The gap the helper tests could not see.
 *
 * Assembly resolved the turn as unattended and the decision path re-resolved it
 * from the step config alone, so the agent was told not to ask and then judged
 * as though it could. Every site now reads the trigger through one function;
 * these pin that it is actually one.
 */
describe('every site that resolves a running step', () => {
  const standingAssistant = {
    agentRole: 'assistant',
    requestInputPolicy: 'allowed',
    completionPolicy: 'open_ended',
  };

  it('reads a scheduled assistant off its stored config as terminal', () => {
    const resolved = resolveAgentPoliciesFromConfig(standingAssistant, { trigger: 'schedule' });

    expect(resolved.requestInputPolicy).toBe('never');
    expect(resolved.completionPolicy).toBe('must_complete_or_block');
  });

  it('leaves the same configuration alone when a person started the run', () => {
    const chat = resolveAgentPoliciesFromConfig(standingAssistant, { trigger: 'chat' });

    expect(chat.requestInputPolicy).toBe('allowed');
    expect(chat.completionPolicy).toBe('open_ended');
  });

  it('treats a webhook like a schedule, since neither has anyone waiting', () => {
    expect(isUnattendedTrigger('webhook')).toBe(true);
    expect(isUnattendedTrigger('schedule')).toBe(true);
    expect(isUnattendedTrigger('chat')).toBe(false);
    expect(isUnattendedTrigger(undefined)).toBe(false);
  });

  it('keeps a delegate override winning over the stored role', () => {
    const asSubagent = resolveAgentPoliciesFromConfig(standingAssistant, {
      agentRoleOverride: 'subagent',
      trigger: 'schedule',
    });

    expect(asSubagent.agentRole).toBe('subagent');
  });
});
