/**
 * Contract: a harness run's browser is the platform agents' browser, reached
 * through a relay that has none (Plan 320 D11).
 *
 * The relay answers the MCP handshake and its tool list itself and passes each
 * call down a pipe; the executor's end performs it through the code a browser
 * step runs. No Chrome is started and no socket is listened on: the driver is
 * the fake one, and the pipes are named pipes in a temporary directory.
 */
import { execFile } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  BROWSER_PAGE_ACT_OPERATION_ID,
  BROWSER_PAGE_CLOSE_OPERATION_ID,
  BROWSER_PAGE_LIST_OPERATION_ID,
  BROWSER_PAGE_NAVIGATE_OPERATION_ID,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BROWSER_PAGE_READ_OPERATION_ID,
  BROWSER_PAGE_SCREENSHOT_OPERATION_ID,
  BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
  BrowserPageOpenInputSchema,
  getOperation,
  type HarnessActivityLine,
  HarnessBrowserLogRecordSchema,
  type PayloadRef,
  toJsonSchemaSync,
} from '@aflow/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenRequest } from '../browser/driverTypes.js';
import {
  browserLogText,
  EPHEMERAL_PROFILE_SCRATCH_PREFIX,
  HARNESS_BROWSER_DIR,
  type HarnessBrowser,
  openHarnessBrowser,
  relayToolDefinitions,
} from '../browser/harnessBrowser.js';
import type { HarnessReach } from '../browser/harnessReach.js';
import { createBrowserHandler } from '../handlers/browserHandler.js';
import { harness, type Harness, profile, RUN_A } from './fixtures/fakeBrowser.js';
import { executorEnd, RELAY_SCRIPT, relayEnd, startRelay } from './fixtures/relayPipes.js';

const VOCABULARY: ReadonlyArray<readonly [string, string]> = [
  ['open', BROWSER_PAGE_OPEN_OPERATION_ID],
  ['navigate', BROWSER_PAGE_NAVIGATE_OPERATION_ID],
  ['snapshot', BROWSER_PAGE_SNAPSHOT_OPERATION_ID],
  ['read', BROWSER_PAGE_READ_OPERATION_ID],
  ['screenshot', BROWSER_PAGE_SCREENSHOT_OPERATION_ID],
  ['act', BROWSER_PAGE_ACT_OPERATION_ID],
  ['list', BROWSER_PAGE_LIST_OPERATION_ID],
  ['close', BROWSER_PAGE_CLOSE_OPERATION_ID],
];

const BLOCKED = 'https://www.blocked.example/';
const DEV_SERVER = 'http://localhost:5173/';
/** The port the operator declared for the harness in these tests. */
const DEV_PORT = 5173;
/** A harness that may reach nothing, with its dev server's port declared. */
const DEV_REACH: HarnessReach = { allowedDomains: [], localPorts: [DEV_PORT] };
/** Documentation-range address, standing in for this machine's LAN address. */
const LAN_ADDRESS = '192.0.2.10';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function world(): Harness {
  const h = harness({
    browsers: [
      profile({ id: 'default' }),
      profile({ id: 'work', rules: [{ origin: '*.blocked.example', effect: 'deny' }] }),
    ],
  });
  h.world.localHosts.add('localhost');
  return h;
}

interface Opened {
  readonly browser: HarnessBrowser;
  readonly activity: HarnessActivityLine[];
  readonly stored: Array<{ data: string; mimeType: string }>;
  readonly scratch: string;
  readonly ephemeralRoot: string;
}

async function openBrowser(
  h: Harness,
  profileName: string,
  reach: HarnessReach = DEV_REACH,
  inFlightGraceMs?: number,
): Promise<Opened> {
  const scratch = await tempDir('aflow-harness-browser-');
  const ephemeralRoot = await tempDir('aflow-harness-ephemeral-');
  const activity: HarnessActivityLine[] = [];
  const stored: Array<{ data: string; mimeType: string }> = [];
  const browser = await openHarnessBrowser({
    driver: h.driver,
    scope: RUN_A,
    profile: profileName,
    reach,
    scratchDir: scratch,
    stepExecutionId: 'se-harness',
    storeScreenshot: (image) => {
      stored.push(image);
      return Promise.resolve(`inline:shot${String(stored.length)}` as PayloadRef);
    },
    onActivity: (line) => activity.push(line),
    startedAt: 0,
    ephemeralRoot,
    ...(inFlightGraceMs !== undefined ? { inFlightGraceMs } : {}),
  });
  cleanup.push(async () => {
    await browser.close();
  });
  return { browser, activity, stored, scratch, ephemeralRoot };
}

/** Speaks as a turn's relay does, straight down that turn's pipes. */
function asRelay(browser: HarnessBrowser): {
  call(tool: string, args: Record<string, unknown>): Promise<CallResult>;
} {
  const opening = browser.openTurn().then((turn) => {
    const [, , requestPath = '', responsePath = ''] = turn.relayArgs;
    const end = relayEnd(requestPath, responsePath);
    cleanup.push(() => {
      end.close();
      return Promise.resolve();
    });
    return end;
  });
  let id = 0;
  return {
    call: async (tool, args) => {
      const end = await opening;
      id += 1;
      const sent = id;
      end.send({ id: sent, tool, arguments: args });
      const answer = await end.next((message) => message['id'] === sent);
      return answer['result'] as CallResult;
    },
  };
}

interface CallResult {
  readonly content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  readonly isError?: boolean;
}

function body(result: CallResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('the relay', () => {
  it('answers the MCP handshake and lists the browser vocabulary against a fake executor end', async () => {
    const dir = await tempDir('aflow-relay-');
    const tools = join(dir, 'tools.json');
    const request = join(dir, 'request.pipe');
    const response = join(dir, 'response.pipe');
    await writeFile(tools, JSON.stringify(relayToolDefinitions(true)));
    await promisify(execFile)('mkfifo', [request, response]);
    const executor = executorEnd(request, response);
    cleanup.push(() => {
      executor.close();
      return Promise.resolve();
    });
    const relay = startRelay([RELAY_SCRIPT, tools, request, response]);
    cleanup.push(async () => {
      await relay.stop();
    });

    const init = await relay.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(init['result']).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'aflow-browser' },
    });
    relay.notify('notifications/initialized');

    const listed = (await relay.request('tools/list'))['result'] as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      ...VOCABULARY.map(([name]) => name),
      'evaluate',
    ]);

    // A call goes down the pipe as it came, and the executor's answer comes back as the result.
    const calling = relay.request('tools/call', {
      name: 'list',
      arguments: {},
    });
    const passed = await executor.next(() => true);
    expect(passed).toMatchObject({ tool: 'list', arguments: {} });
    executor.send({
      id: passed['id'],
      result: { content: [{ type: 'text', text: '{"pages":[]}' }] },
    });
    expect((await calling)['result']).toEqual({
      content: [{ type: 'text', text: '{"pages":[]}' }],
    });

    const unknown = await relay.request('tools/call', { name: 'handoff', arguments: {} });
    expect(unknown['error']).toMatchObject({ code: -32602 });
    expect((await relay.request('resources/list'))['error']).toMatchObject({ code: -32601 });
  });

  it('takes each tool’s input schema from the operation’s own Zod schema', () => {
    const tools = relayToolDefinitions(false);
    expect(tools.map((tool) => tool.name)).toEqual(VOCABULARY.map(([name]) => name));
    for (const [name, operationId] of VOCABULARY) {
      const zod =
        name === 'open'
          ? BrowserPageOpenInputSchema.omit({ profileId: true })
          : getOperation(operationId)?.inputZod;
      if (zod === undefined) throw new Error(`no ${operationId}`);
      const { $schema: _draft, ...expected } = toJsonSchemaSync(zod) as Record<string, unknown>;
      expect(tools.find((tool) => tool.name === name)?.inputSchema, name).toEqual(expected);
    }
    // The run's profile is fixed when it starts; a tool cannot name another.
    const open = tools.find((tool) => tool.name === 'open')?.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(open.properties)).not.toContain('profileId');
  });

  it('carries a call from the harness through real pipes to the driver and back', async () => {
    const h = world();
    const { browser, scratch } = await openBrowser(h, 'default');
    const turn = await browser.openTurn();
    expect(turn.mcpConfigPath).toBe(join(scratch, HARNESS_BROWSER_DIR, 'turn-1', 'mcp.json'));

    const relay = startRelay(turn.relayArgs);
    cleanup.push(async () => {
      await relay.stop();
    });
    await relay.request('initialize', { protocolVersion: '2025-06-18' });
    const opened = (
      await relay.request('tools/call', {
        name: 'open',
        arguments: { url: 'https://app.example/' },
      })
    )['result'] as CallResult;
    expect(opened.isError).toBeUndefined();
    expect(body(opened)).toMatchObject({
      outcome: 'performed',
      url: 'https://app.example/',
      receipt: { profileId: 'default' },
    });
    expect(h.pages).toHaveLength(1);
  });

  it('gives each turn pipes of its own, so a killed turn’s call never answers the next turn’s', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'default');
    let release = (): void => undefined;
    h.world.navigationHeld = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = await browser.openTurn();
    const killed = startRelay(first.relayArgs);
    cleanup.push(async () => {
      await killed.stop();
    });
    await killed.request('initialize', { protocolVersion: '2025-06-18' });
    void killed.request('tools/call', { name: 'open', arguments: { url: 'https://app.example/' } });
    await expect.poll(() => h.pages.length).toBe(1);
    killed.child.kill('SIGKILL');
    await killed.stop();
    // Half a request, as a relay killed while writing one leaves it.
    const [, , firstRequestPath = ''] = first.relayArgs;
    const half = openSync(firstRequestPath, constants.O_WRONLY | constants.O_NONBLOCK);
    writeSync(half, '{"id":2,"tool":"li');
    closeSync(half);
    await first.close();
    await expect(access(join(first.mcpConfigPath, '..'))).rejects.toThrow();

    const second = await browser.openTurn();
    expect(second.relayArgs).not.toEqual(first.relayArgs);
    const relay = startRelay(second.relayArgs);
    cleanup.push(async () => {
      await relay.stop();
    });
    await relay.request('initialize', { protocolVersion: '2025-06-18' });
    const calling = relay.request('tools/call', {
      name: 'open',
      arguments: { url: 'https://other.example/' },
    });
    await expect.poll(() => h.pages.length).toBe(2);
    release();

    const answered = (await calling)['result'] as CallResult;
    expect(answered.isError).toBeUndefined();
    expect(body(answered)).toMatchObject({ url: 'https://other.example/' });
    // The killed turn's call was still performed and logged; only its answer went nowhere.
    expect(browser.records().map((entry) => entry.origin)).toEqual([
      'https://app.example',
      'https://other.example',
    ]);
  });
});

describe('a deny rule', () => {
  type Path = 'operation' | 'relay';

  async function openThrough(path: Path, h: Harness): Promise<{ code: string; message: string }> {
    if (path === 'operation') {
      let written: unknown;
      const ctx = {
        tenantId: RUN_A.tenantId,
        runId: RUN_A.runId,
        spaceId: RUN_A.spaceId,
        attempt: 1,
        stepExecutionId: 'se-step',
        operationId: BROWSER_PAGE_OPEN_OPERATION_ID,
        job: { inputRef: 'inline:input' },
        readPayload: () => Promise.resolve({ url: BLOCKED, profileId: 'work' }),
        writePayload: (_kind: string, data: unknown) => {
          written = data;
          return Promise.resolve('inline:error');
        },
      } as unknown as ExecutorContext;
      const result = await createBrowserHandler(h.driver).execute(ctx);
      expect(result.status).toBe('FAILED');
      return written as { code: string; message: string };
    }
    const { browser } = await openBrowser(h, 'work');
    const result = await asRelay(browser).call('open', { url: BLOCKED });
    expect(result.isError).toBe(true);
    return (body(result) as { error: { code: string; message: string } }).error;
  }

  it.each<Path>(['operation', 'relay'])('refuses the same way through the %s', async (path) => {
    const h = world();
    const refused = await openThrough(path, h);
    expect(refused.code).toBe('BROWSER_ORIGIN_DENIED');
    expect(refused.message).toBe(
      'Browser profile `work` does not allow opening pages at https://www.blocked.example: the ' +
        "operator's rule `*.blocked.example` denies it. Rules are set on the machine.",
    );
    expect(h.launches).toHaveLength(0);
  });
});

describe('the ephemeral profile', () => {
  it('is made for the run, reaches its declared port, and is gone with the run', async () => {
    const h = world();
    const { browser, ephemeralRoot, scratch, activity } = await openBrowser(h, 'ephemeral');
    const [made] = await readdir(ephemeralRoot);
    expect(made?.startsWith(EPHEMERAL_PROFILE_SCRATCH_PREFIX)).toBe(true);

    const relay = asRelay(browser);
    const opened = await relay.call('open', { url: DEV_SERVER });
    expect(opened.isError).toBeUndefined();
    const profileId = (body(opened)['receipt'] as { profileId: string }).profileId;
    expect(profileId).toMatch(/^ephemeral-[0-9a-f]+$/);
    // Its own Chrome, in its own directory, not the default profile's.
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.profile.id).toBe(profileId);
    expect(h.launches[0]?.userDataDir).toBe(join(ephemeralRoot, made ?? ''));
    expect(activity.map((line) => line.kind === 'tool' && line.tool)).toEqual([
      'browser.page.open',
    ]);

    await browser.close();
    expect(h.stops).toHaveLength(1);
    expect(await readdir(ephemeralRoot)).toEqual([]);
    await expect(access(join(scratch, HARNESS_BROWSER_DIR))).rejects.toThrow();
    // Another run could not have reached it, and nothing reaches it now.
    await expect(
      h.driver.open({ ...RUN_A, profileId, url: 'https://app.example/', redelivered: false }),
    ).rejects.toMatchObject({ kind: 'unknown_profile' });
  });

  it('is the only profile that reaches a declared port', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'default');
    const refused = await asRelay(browser).call('open', { url: DEV_SERVER });
    expect(refused.isError).toBe(true);
    expect((body(refused)['error'] as { code: string }).code).toBe('BROWSER_ORIGIN_REFUSED');
  });

  it('belongs to its run alone', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'ephemeral');
    const opened = await asRelay(browser).call('open', { url: DEV_SERVER });
    const profileId = (body(opened)['receipt'] as { profileId: string }).profileId;
    await expect(
      h.driver.open({
        tenantId: RUN_A.tenantId,
        runId: 'run-b',
        spaceId: RUN_A.spaceId,
        profileId,
        url: DEV_SERVER,
        redelivered: false,
      }),
    ).rejects.toMatchObject({ kind: 'unknown_profile' });
  });
});

describe('what the ephemeral profile reaches', () => {
  function code(result: CallResult): string | undefined {
    return (body(result)['error'] as { code?: string } | undefined)?.code;
  }

  it('reaches no public address when its harness may reach none', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'ephemeral', { allowedDomains: [], localPorts: [] });
    const refused = await asRelay(browser).call('open', { url: 'https://example.com/' });
    expect(refused.isError).toBe(true);
    expect(code(refused)).toBe('BROWSER_ORIGIN_DENIED');
    expect(body(refused)['error']).toMatchObject({
      message: expect.stringContaining('reaches only what its harness may reach'),
    });
    expect(h.pages.flatMap((page) => page.history)).toEqual([]);
  });

  it('reaches what its harness may reach, and nothing else', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'ephemeral', {
      allowedDomains: ['example.com'],
      localPorts: [],
    });
    const relay = asRelay(browser);
    const opened = await relay.call('open', { url: 'https://example.com/' });
    expect(opened.isError).toBeUndefined();
    const { pageId } = body(opened) as { pageId: string };

    const other = await relay.call('open', { url: 'https://example.org/' });
    expect(code(other)).toBe('BROWSER_ORIGIN_DENIED');
    const moved = await relay.call('navigate', { pageId, url: 'https://example.org/' });
    expect(code(moved)).toBe('BROWSER_ORIGIN_DENIED');
    expect(h.pages.flatMap((page) => page.history)).toEqual(['https://example.com/']);
  });

  it('is refused at the proxy for a redirect or a subresource beyond its harness’s reach', async () => {
    const h = world();
    h.world.redirects.set('https://example.com/out', 'https://example.org/landing');
    h.world.subresources.set('https://example.com/', ['https://tracker.example.net/pixel']);
    const { browser } = await openBrowser(h, 'ephemeral', {
      allowedDomains: ['example.com'],
      localPorts: [],
    });
    const relay = asRelay(browser);
    expect((await relay.call('open', { url: 'https://example.com/' })).isError).toBeUndefined();
    const redirected = await relay.call('open', { url: 'https://example.com/out' });
    expect(code(redirected)).toBe('BROWSER_ORIGIN_DENIED');
    expect(h.proxies.at(-1)?.refusals.map(({ host, kind }) => ({ host, kind }))).toEqual([
      { host: 'tracker.example.net', kind: 'reach' },
      { host: 'example.org', kind: 'reach' },
    ]);
  });

  it('reaches no port on this machine when none was declared', async () => {
    const h = world();
    h.interfaces.push(LAN_ADDRESS);
    const { browser } = await openBrowser(h, 'ephemeral', { allowedDomains: [], localPorts: [] });
    const relay = asRelay(browser);
    for (const url of [
      DEV_SERVER,
      'http://127.0.0.1:5173/',
      'http://[::1]:5173/',
      'http://[::ffff:127.0.0.1]:5173/',
      'http://0.0.0.0:5173/',
      `http://${LAN_ADDRESS}:5173/`,
    ]) {
      const refused = await relay.call('open', { url });
      expect(code(refused), url).toBe('BROWSER_ORIGIN_REFUSED');
    }
    expect(h.launches).toHaveLength(0);
  });

  it('reaches a declared port on loopback, and not on the LAN address nor any other port', async () => {
    const h = world();
    h.interfaces.push(LAN_ADDRESS);
    const { browser } = await openBrowser(h, 'ephemeral');
    const relay = asRelay(browser);
    for (const url of [DEV_SERVER, 'http://127.0.0.1:5173/']) {
      expect((await relay.call('open', { url })).isError, url).toBeUndefined();
    }
    for (const url of [
      `http://${LAN_ADDRESS}:5173/`,
      'http://localhost:3001/',
      'http://127.0.0.1:3000/',
    ]) {
      expect(code(await relay.call('open', { url })), url).toBe('BROWSER_ORIGIN_REFUSED');
    }
  });
});

describe('script evaluation', () => {
  it('runs on the ephemeral profile', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'ephemeral');
    const relay = asRelay(browser);
    const { pageId } = body(await relay.call('open', { url: DEV_SERVER })) as { pageId: string };
    const evaluated = await relay.call('evaluate', { pageId, expression: 'document.title' });
    expect(evaluated.isError).toBeUndefined();
    expect(body(evaluated)).toMatchObject({ pageId, cut: false });
    expect(h.pages[0]?.evaluations).toEqual(['document.title']);
  });

  it('is logged as performed, since a page script can click or submit', async () => {
    const h = world();
    const { browser, activity } = await openBrowser(h, 'ephemeral');
    const relay = asRelay(browser);
    const { pageId } = body(await relay.call('open', { url: DEV_SERVER })) as { pageId: string };
    await relay.call('evaluate', { pageId, expression: 'document.forms[0].submit()' });
    expect(browser.records().at(-1)).toMatchObject({
      action: 'evaluate',
      pageId,
      outcome: 'performed',
    });
    expect(activity.at(-1)).toMatchObject({
      tool: 'browser.page.evaluate',
      text: expect.stringMatching(/— performed$/),
    });
  });

  it('is refused on a named profile, and not offered there', async () => {
    const h = world();
    const { browser } = await openBrowser(h, 'default');
    expect(relayToolDefinitions(false).map((tool) => tool.name)).not.toContain('evaluate');
    const relay = asRelay(browser);
    const { pageId } = body(await relay.call('open', { url: 'https://app.example/' })) as {
      pageId: string;
    };
    const refused = await relay.call('evaluate', { pageId, expression: 'document.cookie' });
    expect(refused.isError).toBe(true);
    expect((body(refused)['error'] as { code: string }).code).toBe('BROWSER_SCRIPT_REFUSED');
    expect(h.pages[0]?.evaluations).toEqual([]);
  });
});

/** The harness's driver, its `open` held until the test lets it go. */
function openHeld(h: Harness): { harness: Harness; reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const driver = new Proxy(h.driver, {
    get: (target, key) => {
      if (key === 'open') {
        return async (request: OpenRequest) => {
          arrive();
          await held;
          return await target.open(request);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { harness: { ...h, driver }, reached, release };
}

describe('the end of a run', () => {
  it('closes a page an open still in flight makes after the run ended, and logs the call as abandoned', async () => {
    const h = world();
    const slow = openHeld(h);
    const { browser, activity } = await openBrowser(slow.harness, 'default', DEV_REACH, 0);
    // Its answer would go to a turn that is gone, so it is never awaited.
    void asRelay(browser).call('open', { url: 'https://app.example/' });
    await slow.reached;

    await browser.close();
    const logged = browserLogText(browser.records())
      .trimEnd()
      .split('\n')
      .map((line) => HarnessBrowserLogRecordSchema.strict().parse(JSON.parse(line)));
    expect(logged).toEqual([
      { at: expect.any(String), profile: 'default', action: 'open', outcome: 'abandoned' },
    ]);
    expect(activity.at(-1)).toMatchObject({ tool: 'browser.page.open', text: 'open — abandoned' });
    expect(h.pages).toEqual([]);

    slow.release();
    await vi.waitFor(() => {
      expect(h.pages.length).toBeGreaterThan(0);
      expect(h.pages.filter((page) => !page.closed)).toEqual([]);
    });
    expect(browser.records()).toHaveLength(1);
  });
});

describe('the browser log', () => {
  it('records every call, typed text by length only, and each as a tool line in the feed', async () => {
    const h = world();
    const { browser, activity, stored } = await openBrowser(h, 'work');
    const relay = asRelay(browser);
    const { pageId } = body(await relay.call('open', { url: 'https://app.example/' })) as {
      pageId: string;
    };
    await relay.call('act', { pageId, ref: 'e4', action: 'type', text: 'hello planted words' });
    const shot = await relay.call('screenshot', { pageId });
    await relay.call('navigate', { pageId, url: BLOCKED });
    // Someone else's page in the same run is not the harness's to touch.
    const foreign = await relay.call('snapshot', { pageId: 'p-not-mine' });

    expect(shot.content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(shot.content[1]).toMatchObject({ mimeType: 'image/png', data: stored[0]?.data });
    expect(shot.content[0]?.text).not.toContain('inline:shot1');
    expect(foreign.isError).toBe(true);

    const text = browserLogText(browser.records());
    expect(text).not.toContain('hello planted words');
    const records = text
      .trimEnd()
      .split('\n')
      .map((line) => HarnessBrowserLogRecordSchema.strict().parse(JSON.parse(line)));
    expect(
      records.map(({ action, outcome, origin, code }) => ({ action, outcome, origin, code })),
    ).toEqual([
      { action: 'open', outcome: 'performed', origin: 'https://app.example', code: undefined },
      { action: 'act.type', outcome: 'performed', origin: 'https://app.example', code: undefined },
      { action: 'screenshot', outcome: 'read', origin: 'https://app.example', code: undefined },
      {
        action: 'navigate',
        outcome: 'refused',
        origin: 'https://www.blocked.example',
        code: 'BROWSER_ORIGIN_DENIED',
      },
      { action: 'snapshot', outcome: 'failed', origin: undefined, code: 'PAGE_GONE' },
    ]);
    expect(records[1]).toMatchObject({
      profile: 'work',
      pageId,
      element: { role: 'textbox', name: 'Email' },
      typedCharacters: 19,
    });
    // What the harness saw is kept for the operator, though the harness never sees the reference.
    expect(records.map((entry) => entry.screenshot)).toEqual([
      undefined,
      undefined,
      'inline:shot1',
      undefined,
      undefined,
    ]);
    expect(activity.map((line) => (line.kind === 'tool' ? line.tool : line.kind))).toEqual([
      'browser.page.open',
      'browser.page.act',
      'browser.page.screenshot',
      'browser.page.navigate',
      'browser.page.snapshot',
    ]);
  });
});
