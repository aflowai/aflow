import { describe, expect, it } from 'vitest';
import { HttpRehearsalClient } from './httpRehearsalClient.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';

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
        body: { currentVersion: 37, catalogVersion: 37, divergence: { customized: false } },
      },
    });
    expect(await client(installed.impl).readInstall('alpaca-thesis-trading')).toEqual({
      ok: true,
      installedVersion: 37,
      catalogVersion: 37,
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

  it('starts a run through workflow.run.start, pinned to the installed skill', async () => {
    const fetch = fakeFetch({
      'POST /v1/sessions': { body: { sessionId: 'sess-1' } },
      'GET /v1/sessions/sess-1': [
        { body: { status: 'RUNNING' } },
        { body: { status: 'SUCCEEDED' } },
      ],
      [`GET /v1/spaces/${SPACE}/workflows/daily-trading-cycle/runs`]: {
        body: {
          runs: [
            { runId: 'old-run', startedAt: '2000-01-01T00:00:00Z' },
            { runId: RUN, startedAt: new Date(Date.now() + 1_000).toISOString() },
          ],
        },
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
