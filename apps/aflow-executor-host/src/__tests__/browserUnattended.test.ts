/**
 * A profile with `unattended: false` takes only runs a person last set going —
 * a message in a conversation or by voice, an answer in the Action Center, the
 * same run once a sub-agent it waited on returns, or a run delegated from one
 * while it was — and refuses every other before it opens or reuses a page.
 * Whether a person did is the `activatedByPerson` each job carries, which
 * changes as the run is resumed; a job without it is nobody's. A profile left
 * at the default takes every run, as it always has.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunScope } from '../browser/driverTypes.js';
import type { HandoffBoard } from '../browser/handoffBoard.js';
import { openHarnessBrowser } from '../browser/harnessBrowser.js';
import { createBrowserHandler, jobScopeOf } from '../handlers/browserHandler.js';
import { harness, type Harness, profile, refusal, RUN_A, RUN_B } from './fixtures/fakeBrowser.js';

const UNATTENDED: ReadonlyArray<boolean | undefined> = [false, undefined];

const SCHEDULED: RunScope = { ...RUN_A, activatedByPerson: false };
const CHATTED: RunScope = { ...RUN_B, activatedByPerson: true };

function asRun(activatedByPerson: boolean | undefined): RunScope {
  return activatedByPerson === undefined ? RUN_A : { ...RUN_A, activatedByPerson };
}

const ATTENDED_ONLY = profile({ id: 'work', unattended: false });

function machine(board?: HandoffBoard): Harness {
  return harness({
    browsers: [profile({ id: 'default' }), ATTENDED_ONLY],
    ...(board !== undefined ? { handoffs: board } : {}),
  });
}

async function open(h: Harness, run: RunScope, profileId = 'work'): Promise<string> {
  return (
    await h.driver.open({ ...run, redelivered: false, profileId, url: 'https://example.com/' })
  ).pageId;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe('a profile closed to runs nobody is present for', () => {
  it.each(UNATTENDED)(
    'refuses to open a page for a job whose activatedByPerson is %s, before any browser starts',
    async (activatedByPerson) => {
      const h = machine();
      const refused = await refusal(open(h, asRun(activatedByPerson)));

      expect(refused.kind).toBe('profile_closed_to_unattended');
      expect(refused.message).toContain(
        'Browser profile `work` is closed to runs nobody is present for',
      );
      expect(refused.message).toContain('until a person next sets the run going');
      expect(refused.message).toContain('`aflow browser unattended work allow`');
      expect(refused.message).not.toContain('sub-agent');
      expect(refused.details).toEqual({ profileId: 'work' });
      expect(h.launches).toHaveLength(0);
    },
  );

  it('opens a page for a run a person set going', async () => {
    const h = machine();
    expect(await open(h, asRun(true))).toMatch(/^pg_/);
    expect(h.launches).toHaveLength(1);
  });

  it('refuses a run a person started once a schedule resumes it, and lets it in at their next message', async () => {
    const h = machine();
    const pageId = await open(h, { ...RUN_A, activatedByPerson: true });

    const resumedBySchedule = { ...RUN_A, activatedByPerson: false };
    expect(
      (await refusal(h.driver.readPage(resumedBySchedule, pageId, { what: 'text' }))).kind,
    ).toBe('profile_closed_to_unattended');
    expect(await h.driver.list(resumedBySchedule)).toEqual([]);

    const resumedByMessage = { ...RUN_A, activatedByPerson: true };
    expect((await h.driver.readPage(resumedByMessage, pageId, { what: 'text' })).what).toBe('text');
  });

  it('lets in a person’s run once the sub-agent it waited on returns to it', async () => {
    const h = machine();
    const pageId = await open(h, { ...RUN_A, activatedByPerson: true });

    // The orchestrator leaves the parent's activation as the wait found it,
    // so its next job carries the same fact.
    const afterSubAgent = { ...RUN_A, activatedByPerson: true };
    expect((await h.driver.readPage(afterSubAgent, pageId, { what: 'text' })).what).toBe('text');
    expect(await open(h, afterSubAgent)).toMatch(/^pg_/);
  });

  it('closes a page on a policy change by its run’s latest call, not by how it opened', async () => {
    const h = machine();
    h.setProfiles([profile({ id: 'default' }), profile({ id: 'work' })]);
    const pageId = await open(h, { ...RUN_A, activatedByPerson: true });
    await h.driver.snapshot({ ...RUN_A, activatedByPerson: false }, pageId);

    await h.driver.policyChanged({
      browsers: new Map([
        ['default', profile({ id: 'default' })],
        ['work', ATTENDED_ONLY],
      ]),
      invalidBrowsers: new Map(),
      chrome: { found: { label: 'Chromium', path: '/usr/bin/chromium' }, searched: [] },
    });

    expect(
      (await refusal(h.driver.snapshot({ ...RUN_A, activatedByPerson: true }, pageId))).kind,
    ).toBe('page_gone');
  });

  it('refuses every operation on a page the run opened before the profile closed', async () => {
    const posted = vi.fn();
    const h = machine({ post: posted });
    h.setProfiles([profile({ id: 'default' }), profile({ id: 'work' })]);
    const scheduled = await open(h, SCHEDULED);
    const chatted = await open(h, CHATTED);
    h.setProfiles([profile({ id: 'default' }), ATTENDED_ONLY]);

    const refusals = await Promise.all([
      refusal(
        h.driver.navigate({
          ...SCHEDULED,
          pageId: scheduled,
          to: { kind: 'reload' },
          redelivered: false,
        }),
      ),
      refusal(
        h.driver.act({
          ...SCHEDULED,
          pageId: scheduled,
          ref: 'e6',
          action: { kind: 'click' },
          redelivered: false,
        }),
      ),
      refusal(h.driver.readPage(SCHEDULED, scheduled, { what: 'text' })),
      refusal(h.driver.snapshot(SCHEDULED, scheduled)),
      refusal(h.driver.screenshot(SCHEDULED, scheduled, { fullPage: false })),
      refusal(
        h.driver.handoff({
          ...SCHEDULED,
          stepExecutionId: 'step-handoff',
          pageId: scheduled,
          reason: 'sign_in',
          message: 'Sign in to the site.',
        }),
      ),
    ]);
    expect(refusals.map((each) => each.kind)).toEqual(
      Array.from({ length: 6 }, () => 'profile_closed_to_unattended'),
    );
    expect(posted).not.toHaveBeenCalled();
    expect(h.pages[0]?.actions).toEqual([]);
    expect(await h.driver.list(SCHEDULED)).toEqual([]);

    const read = await h.driver.readPage(CHATTED, chatted, { what: 'text' });
    expect(read.what).toBe('text');
    expect((await h.driver.list(CHATTED)).map((page) => page.pageId)).toEqual([chatted]);
  });

  it('closes the pages of runs nobody is present for when the change reaches the executor', async () => {
    const h = machine();
    h.setProfiles([profile({ id: 'default' }), profile({ id: 'work' })]);
    const scheduled = await open(h, SCHEDULED);
    const chatted = await open(h, CHATTED);

    await h.driver.policyChanged({
      browsers: new Map([
        ['default', profile({ id: 'default' })],
        ['work', ATTENDED_ONLY],
      ]),
      invalidBrowsers: new Map(),
      chrome: { found: { label: 'Chromium', path: '/usr/bin/chromium' }, searched: [] },
    });

    expect((await refusal(h.driver.snapshot(SCHEDULED, scheduled))).kind).toBe('page_gone');
    expect((await h.driver.snapshot(CHATTED, chatted)).pageId).toBe(chatted);
  });

  it('lets a run nobody is present for use the profiles that take it', async () => {
    const h = machine();
    expect(await open(h, SCHEDULED, 'default')).toMatch(/^pg_/);
  });
});

describe('a profile left to take runs nobody is present for', () => {
  it.each([true, false, undefined])(
    'opens, moves, acts on and reads a page for a job whose activatedByPerson is %s',
    async (activatedByPerson) => {
      const h = machine();
      const run = asRun(activatedByPerson);
      const pageId = await open(h, run, 'default');
      await h.driver.navigate({ ...run, pageId, to: { kind: 'reload' }, redelivered: false });
      await h.driver.act({
        ...run,
        pageId,
        ref: 'e6',
        action: { kind: 'click' },
        redelivered: false,
      });
      expect((await h.driver.readPage(run, pageId, { what: 'text' })).what).toBe('text');
    },
  );
});

describe('browser.profile.list', () => {
  it('marks a profile closed to a run nobody is present for rather than hiding it', async () => {
    const listed = await machine().driver.listProfiles(SCHEDULED);
    expect(
      listed.map(({ profileId, unattended, openToThisRun }) => ({
        profileId,
        unattended,
        openToThisRun,
      })),
    ).toEqual([
      { profileId: 'default', unattended: true, openToThisRun: true },
      { profileId: 'work', unattended: false, openToThisRun: false },
    ]);
  });

  it('shows the same profile open to a run a person set going', async () => {
    const listed = await machine().driver.listProfiles(CHATTED);
    expect(listed.find((each) => each.profileId === 'work')).toMatchObject({
      unattended: false,
      openToThisRun: true,
    });
  });
});

interface Ran {
  readonly result: StepResult;
  readonly written: unknown;
}

/** A browser step as the executor receives it, with the job's activatedByPerson or none. */
async function step(
  h: Harness,
  operationId: string,
  input: unknown,
  activatedByPerson?: boolean,
): Promise<Ran> {
  let written: unknown;
  const ctx = {
    ...RUN_A,
    attempt: 1,
    operationId,
    stepExecutionId: 'step-1',
    job: {
      inputRef: 'inline:input',
      sessionId: RUN_A.runId,
      ...(activatedByPerson !== undefined ? { activatedByPerson } : {}),
    },
    readPayload: () => Promise.resolve(input),
    writePayload: (_kind: string, data: unknown) => {
      written = data;
      return Promise.resolve('inline:output');
    },
  } as unknown as ExecutorContext;
  return { result: await createBrowserHandler(h.driver).execute(ctx), written };
}

describe('a browser step', () => {
  it('fails a job nobody is present for on a closed profile as a permission refusal', async () => {
    for (const activatedByPerson of [false, undefined] as const) {
      const h = machine();
      const ran = await step(
        h,
        'browser.page.open',
        { url: 'https://example.com/', profileId: 'work' },
        activatedByPerson,
      );
      expect(ran.result.status).toBe('FAILED');
      expect(ran.written).toMatchObject({
        code: 'BROWSER_PROFILE_CLOSED_TO_UNATTENDED',
        classification: 'permission',
        retryable: false,
        details: { profileId: 'work' },
      });
      expect(h.launches).toHaveLength(0);
    }
  });

  it('opens the page for a job a person set going', async () => {
    const ran = await step(
      machine(),
      'browser.page.open',
      { url: 'https://example.com/', profileId: 'work' },
      true,
    );
    expect(ran.result.status).toBe('SUCCEEDED');
  });

  it('lists a closed profile as closed to a job that does not say a person set it going', async () => {
    const ran = await step(machine(), 'browser.profile.list', {});
    expect(ran.written).toMatchObject({
      profiles: [
        { profileId: 'default', openToThisRun: true },
        { profileId: 'work', unattended: false, openToThisRun: false },
      ],
    });
  });

  it('takes whether a person set its run going from the job and nowhere else', () => {
    const ctx = (job: Record<string, unknown>) =>
      ({ ...RUN_A, job: { inputRef: 'inline:x', ...job } }) as unknown as ExecutorContext;
    expect(jobScopeOf(ctx({ activatedByPerson: true }))).toEqual({
      ...RUN_A,
      activatedByPerson: true,
    });
    expect(jobScopeOf(ctx({}))).toEqual(RUN_A);
  });
});

describe('a harness run’s browser', () => {
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aflow-unattended-harness-'));
    cleanup.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    return dir;
  }

  async function openFor(h: Harness, scope: RunScope & { spaceId: string }) {
    return await openHarnessBrowser({
      driver: h.driver,
      scope,
      profile: 'work',
      reach: { allowedDomains: [], localPorts: [] },
      scratchDir: await scratch(),
      stepExecutionId: 'se-harness',
      storeScreenshot: () => Promise.reject(new Error('no screenshot expected')),
      onActivity: () => undefined,
      startedAt: 0,
    });
  }

  it('is refused a closed profile before the harness starts, for a run nobody is present for', async () => {
    const h = machine();
    const refused = await refusal(openFor(h, { ...RUN_A, activatedByPerson: false }));
    expect(refused.kind).toBe('profile_closed_to_unattended');
    expect(h.launches).toHaveLength(0);
  });

  it('is given the closed profile for a run a person set going', async () => {
    const browser = await openFor(machine(), { ...RUN_A, activatedByPerson: true });
    cleanup.push(async () => {
      await browser.close();
    });
    expect(browser.records()).toEqual([]);
  });
});
