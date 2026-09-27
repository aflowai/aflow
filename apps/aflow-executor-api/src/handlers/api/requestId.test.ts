import { describe, it, expect } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { mintRequestId, uuidV5 } from './requestId.js';

function ctxFor(runId: string, logicalExecutionId: string, attempt = 1): ExecutorContext {
  return { runId, logicalExecutionId, job: { attempt } } as unknown as ExecutorContext;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the published RFC 4122 vector for the DNS namespace', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('stamps version 5 and the RFC variant', () => {
    expect(uuidV5('anything', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toMatch(UUID_RE);
  });
});

describe('mintRequestId', () => {
  it('is stable across attempts of one call, so a deduplicating provider sees a replay', () => {
    const first = mintRequestId(ctxFor('run-1', 'step:abc', 1));
    const retry = mintRequestId(ctxFor('run-1', 'step:abc', 4));
    expect(retry).toBe(first);
  });

  it('differs across runs of the SAME workflow task', () => {
    // deriveLogicalExecutionId returns `task:<taskId>` on the workflow path,
    // and taskId is the definition's author-supplied slug — identical in every
    // run. Seeding without runId would send one id for every order the task
    // ever places (Plan 290 §1.2a).
    const runA = mintRequestId(ctxFor('run-A', 'task:execute-orders'));
    const runB = mintRequestId(ctxFor('run-B', 'task:execute-orders'));
    expect(runA).not.toBe(runB);
  });

  it('differs across distinct steps within one run', () => {
    const first = mintRequestId(ctxFor('run-1', 'step:abc'));
    const second = mintRequestId(ctxFor('run-1', 'step:def'));
    expect(first).not.toBe(second);
  });

  it('emits a well-formed UUID', () => {
    expect(mintRequestId(ctxFor('run-1', 'step:abc'))).toMatch(UUID_RE);
  });
});
