import { describe, expect, it } from 'vitest';
import { HttpRehearsalClient } from './httpRehearsalClient.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';
const SCHEDULED_RUN = '99999999-9999-4999-8999-999999999999';

const inline = (value: unknown) =>
  `inline:${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))}`;

type Answer = { status?: number; body: unknown };

function fakeFetch(routes: Record<string, Answer | Answer[]>) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  const seen = new Map<string, number>();
  const impl = ((url: string, init: RequestInit) => {
    const path = url.replace('http://stack', '');
    const method = init.method ?? 'GET';
    const key = `${method} ${path.split('?')[0]!}`;
    calls.push({
      method,
      path,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    });
    const route = routes[key];
    if (route === undefined) return Promise.resolve(new Response('no route', { status: 599 }));
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const answer = Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

const client = (fetchImpl: typeof fetch) =>
  new HttpRehearsalClient({
    apiUrl: 'http://stack',
    apiKey: 'key-1',
    spaceId: SPACE,
    fetchImpl,
    startTimeoutMs: 60_000,
  });

describe('the HTTP rehearsal client', () => {
  it('reads the install from the update preview, and a 404 as not installed', async () => {
    const installed = fakeFetch({
      [`POST /v1/spaces/${SPACE}/store/update-preview`]: {
        body: {
          currentVersion: 37,
          catalogVersion: 37,
          installedContentHash: 'hash-installed',
          catalogContentHash: 'hash-catalog',
          divergence: { customized: false },
        },
      },
    });
    expect(await client(installed.impl).readInstall('alpaca-thesis-trading')).toEqual({
      ok: true,
      installedVersion: 37,
      catalogVersion: 37,
      installedContentHash: 'hash-installed',
      catalogContentHash: 'hash-catalog',
      customized: false,
    });
    expect(installed.calls[0]).toMatchObject({
      body: { catalogId: 'alpaca-thesis-trading' },
      headers: { Authorization: 'Bearer key-1' },
    });
    const absent = fakeFetch({
      [`POST /v1/spaces/${SPACE}/store/update-preview`]: {
        status: 404,
        body: { error: 'NOT_INSTALLED', message: 'not installed in this space' },
      },
    });
    expect(await client(absent.impl).readInstall('x')).toEqual({
      ok: false,
      message: 'NOT_INSTALLED: not installed in this space',
    });
  });

  it('starts a run through workflow.run.start, and takes the run id the operation returns', async () => {
    const fetch = fakeFetch({
      'POST /v1/sessions': { body: { sessionId: 'sess-1' } },
      'GET /v1/sessions/sess-1': [
        { body: { status: 'RUNNING' } },
        {
          body: {
            status: 'SUCCEEDED',
            outputRef: inline({
              result: { status: 'started', runId: RUN, slug: 'daily-trading-cycle' },
            }),
          },
        },
      ],
      // A scheduled run of the slug, started at the same moment, is never read as this one.
      [`GET /v1/spaces/${SPACE}/workflows/daily-trading-cycle/runs`]: {
        body: { runs: [{ runId: SCHEDULED_RUN, startedAt: new Date().toISOString() }] },
      },
    });
    const c = client(fetch.impl);
    c.sleep = () => Promise.resolve();
    expect(
      await c.startRun('daily-trading-cycle', 'daily-trading-cycle', { slot: 'open' }),
    ).toEqual({
      ok: true,
      runId: RUN,
    });
    expect(fetch.calls.some((call) => call.path.includes('/runs'))).toBe(false);
    expect(fetch.calls[0]?.body).toEqual({
      mode: 'api',
      target: { kind: 'platform-role', systemRole: 'mcp-runner' },
      input: {
        input: {},
        config: {
          operationId: 'workflow.run.start',
          inputs: {
            slug: 'daily-trading-cycle',
            catalogId: 'daily-trading-cycle',
            inputs: { slot: 'open' },
            wait: 'none',
          },
        },
      },
    });
  });

  it('reads the run id from a stored output and from a run_step envelope', async () => {
    const envelope = {
      result: {
        status: 'SUCCEEDED',
        stepExecutionId: 'step-1',
        operationId: 'workflow.run.start',
        stepType: 'workflow',
        result: { status: 'started', runId: RUN, slug: 'daily-trading-cycle' },
      },
    };
    const fetch = fakeFetch({
      'POST /v1/sessions': { body: { sessionId: 'sess-3' } },
      'GET /v1/sessions/sess-3': {
        body: { status: 'SUCCEEDED', outputRef: 'gs://bucket/out.json' },
      },
      'GET /v1/payloads': { body: envelope },
    });
    expect(
      await client(fetch.impl).startRun('daily-trading-cycle', 'daily-trading-cycle', {}),
    ).toEqual({ ok: true, runId: RUN });
    expect(fetch.calls.at(-1)?.path).toBe(
      `/v1/payloads?ref=${encodeURIComponent('gs://bucket/out.json')}&spaceId=${SPACE}`,
    );
  });

  it('a start whose output names no run, or a run of another slug, does not start', async () => {
    const answer = (output: unknown) =>
      fakeFetch({
        'POST /v1/sessions': { body: { sessionId: 'sess-4' } },
        'GET /v1/sessions/sess-4': { body: { status: 'SUCCEEDED', outputRef: inline(output) } },
      });
    const none = await client(answer({ result: { status: 'started' } }).impl).startRun(
      'daily-trading-cycle',
      'daily-trading-cycle',
      {},
    );
    expect(none).toMatchObject({ ok: false, message: expect.stringContaining('no run id') });
    const other = await client(
      answer({ result: { status: 'started', runId: RUN, slug: 'strategy-desk' } }).impl,
    ).startRun('daily-trading-cycle', 'daily-trading-cycle', {});
    expect(other).toEqual({
      ok: false,
      message: 'workflow.run.start started a run of strategy-desk, not daily-trading-cycle',
    });
  });

  it('reads the exchange clock, then the calendar from the clock’s date on', async () => {
    const clock = {
      statusCode: 200,
      data: { timestamp: '2026-11-24T16:30:00.1-05:00', is_open: false, next_open: 'x' },
    };
    const calendar = {
      statusCode: 200,
      data: [{ date: '2026-11-24', open: '09:30', close: '16:00', session_open: '0400' }],
    };
    const fetch = fakeFetch({
      'POST /v1/sessions': [{ body: { sessionId: 'clock' } }, { body: { sessionId: 'calendar' } }],
      'GET /v1/sessions/clock': {
        body: { status: 'SUCCEEDED', outputRef: inline({ result: clock }) },
      },
      'GET /v1/sessions/calendar': {
        body: { status: 'SUCCEEDED', outputRef: inline({ result: calendar }) },
      },
    });
    const source = {
      apiId: 'alpaca-account-read',
      clockEndpointId: 'get_clock',
      calendarEndpointId: 'get_calendar',
    };
    expect(await client(fetch.impl).readExchange(source)).toEqual({
      ok: true,
      reading: {
        timestamp: '2026-11-24T16:30:00.1-05:00',
        isOpen: false,
        sessions: [{ date: '2026-11-24', open: '09:30', close: '16:00' }],
      },
    });
    const started = fetch.calls.filter((c) => c.method === 'POST');
    expect(started.map((c) => (c.body as { input: { config: unknown } }).input.config)).toEqual([
      {
        operationId: 'api.http.call',
        inputs: {
          apiId: 'alpaca-account-read',
          endpointId: 'get_clock',
          response: { format: 'json' },
        },
      },
      {
        operationId: 'api.http.call',
        inputs: {
          apiId: 'alpaca-account-read',
          endpointId: 'get_calendar',
          params: { start: '2026-11-24', end: '2026-12-08' },
          response: { format: 'json' },
        },
      },
    ]);
  });

  it('a start the operation refuses carries its words', async () => {
    const fetch = fakeFetch({
      'POST /v1/sessions': { body: { sessionId: 'sess-2' } },
      'GET /v1/sessions/sess-2': {
        body: {
          status: 'FAILED',
          error: { code: 'CAMPAIGN_REQUIRED', message: 'start a campaign' },
        },
      },
    });
    expect(
      await client(fetch.impl).startRun('daily-trading-cycle', 'daily-trading-cycle', {}),
    ).toEqual({
      ok: false,
      message: 'CAMPAIGN_REQUIRED: start a campaign',
    });
  });

  it('holds and restores the write policy, and refuses a held write with its origin', async () => {
    const origin = {
      type: 'step',
      runId: 'r',
      stepExecutionId: 's',
      sessionId: 'x',
      pauseVersion: 1,
    };
    const fetch = fakeFetch({
      [`GET /v1/spaces/${SPACE}/write-policy`]: { body: { writePolicy: null } },
      [`PUT /v1/spaces/${SPACE}/write-policy`]: { body: { writePolicy: null } },
      [`GET /v1/spaces/${SPACE}/action-center`]: {
        body: { items: [{ id: 'step:s', origin, title: 'Submit order', kind: 'write_approval' }] },
      },
      [`POST /v1/spaces/${SPACE}/action-center/step%3As/resolve`]: { body: {} },
    });
    const c = client(fetch.impl);
    expect(await c.readWritePolicy()).toBeNull();
    await c.writeWritePolicy({ requireApprovalByTier: { low: true } });
    const held = await c.listHeldWrites();
    await c.refuseWrite(held[0]!, 'no orders');
    expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /v1/spaces/${SPACE}/write-policy`,
      `PUT /v1/spaces/${SPACE}/write-policy`,
      `GET /v1/spaces/${SPACE}/action-center?kind=write_approval`,
      `POST /v1/spaces/${SPACE}/action-center/step%3As/resolve`,
    ]);
    expect(fetch.calls[1]?.body).toEqual({ writePolicy: { requireApprovalByTier: { low: true } } });
    expect(fetch.calls[3]?.body).toEqual({
      origin,
      resolution: { kind: 'reject', reason: 'no orders' },
    });
  });
});
