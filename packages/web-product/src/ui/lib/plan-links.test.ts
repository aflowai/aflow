import { describe, expect, it } from 'vitest';
import type { PlanNodeLink } from '@aflow/schemas';
import { planLinkTarget, planLinkText } from './plan-links.js';

const NODE = '00000000-0000-4000-8000-0000000000a1';
const ID = '00000000-0000-4000-8000-0000000000f1';
const PR = 'https://github.com/aflowai/aflow/pull/181';

function link(kind: PlanNodeLink['kind'], ref: string, label?: string): PlanNodeLink {
  return {
    nodeId: NODE,
    kind,
    ref,
    ...(label !== undefined ? { label } : {}),
    createdAt: '2026-10-05T10:00:00.000Z',
  };
}

describe('planLinkTarget', () => {
  it('opens a run and a conversation on their pages in the space', () => {
    expect(planLinkTarget(link('run', ID), 'my space')).toEqual({
      kind: 'internal',
      href: `/s/my%20space/runs/${ID}`,
    });
    expect(planLinkTarget(link('session', ID), 'work')).toEqual({
      kind: 'internal',
      href: `/s/work/sessions/${ID}`,
    });
  });

  it('opens a pull request and a merge at their URL', () => {
    expect(planLinkTarget(link('pull_request', PR), 'work')).toEqual({
      kind: 'external',
      href: PR,
    });
    expect(planLinkTarget(link('merge', PR), 'work')).toEqual({ kind: 'external', href: PR });
  });

  it('opens a document at its memory path, or its URL', () => {
    expect(planLinkTarget(link('document', '/plans/322 notes.md'), 'work')).toEqual({
      kind: 'internal',
      href: '/s/work/memory/plans/322%20notes.md',
    });
    expect(planLinkTarget(link('document', 'https://example.com/spec'), 'work')).toEqual({
      kind: 'external',
      href: 'https://example.com/spec',
    });
    expect(planLinkTarget(link('document', 'docs/plans/322.md'), 'work')).toEqual({ kind: 'none' });
  });

  it('leads nowhere for a finding or a campaign, which no page here is addressed by', () => {
    expect(planLinkTarget(link('finding', 'F121'), 'work')).toEqual({ kind: 'none' });
    expect(planLinkTarget(link('campaign', ID), 'work')).toEqual({ kind: 'none' });
  });

  it('never makes a link of a pull request ref that is not a web URL', () => {
    expect(planLinkTarget(link('pull_request', 'javascript:alert(1)'), 'work')).toEqual({
      kind: 'none',
    });
  });
});

describe('planLinkText', () => {
  it('names a pull request by repository and number, over its label', () => {
    expect(planLinkText(link('pull_request', PR, 'from publish-local-changes run x'))).toBe(
      'aflow#181',
    );
  });

  it('names anything else by its label, else its ref', () => {
    expect(planLinkText(link('run', ID, 'commission-change completed'))).toBe(
      'commission-change completed',
    );
    expect(planLinkText(link('finding', 'F121'))).toBe('F121');
  });
});
