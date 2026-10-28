/**
 * Contract: a run's preview (Plan 320 D19) is started by the executor in the
 * directory it is given, waited for on its ready path on either loopback
 * family, refused when its fixed port is held — naming the holder only within
 * its workspace — and stopped, its whole group, politely and then not. A small
 * node http server stands in for the folder's dev server.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StackPortOwner } from '@aflow/lib';
import { portTaken } from '@aflow/lib/port-probe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOOPBACK_LISTENER, requires } from './fixtures/capabilities.js';
import {
  claimPreviewPort,
  pickFreeLoopbackPort,
  previewCommand,
  PreviewError,
  previewPortHolder,
  previewReadyUrl,
  startPreview,
  type StartedPreview,
  type StartPreviewInput,
} from '../previewSupervisor.js';
import type { ServiceExit } from '../sandboxedRun.js';

const onLoopback = requires(LOOPBACK_LISTENER);
/** Ports nothing here listens on, for the cases where nothing ever does. */
const UNUSED_PORTS = { silent: 41_791, aborted: 41_792, exits: 41_793 };
const NO_STACK = new Map<number, StackPortOwner>();
const FREE = { stackOwn: NO_STACK, taken: () => Promise.resolve(false) };

function holder(runId: string, spaceId = 'space-a', tenantId = 't1') {
  return { runId, bindingId: 'hb', tenantId, spaceId };
}

/** A preview whose process stands in, for the cases about the wait alone. */
function standIn(): NonNullable<StartPreviewInput['start']> {
  return () => {
    let ended: (exit: ServiceExit) => void = () => undefined;
    const exited = new Promise<ServiceExit>((resolve) => {
      ended = resolve;
    });
    return {
      processId: 'pv_test',
      exited,
      stop: () => {
        ended({ code: null, signal: 'SIGTERM', stderrTail: '' });
      },
    };
  };
}

let dir: string;

/** A dev server: prints what it sees, then answers on `readyPath` once listening. */
const SERVER = `
import { createServer } from 'node:http';
const port = Number(process.argv[2]);
const mode = process.argv[3] ?? 'serve';
console.log('pid=' + process.pid);
console.log('secret=' + (process.env.AFLOW_PREVIEW_TEST_SECRET ?? 'none'));
console.log('port-env=' + (process.env.PORT ?? 'none'));
console.error('token-abc on stderr');
if (mode === 'stubborn') process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
if (mode === 'silent') setInterval(() => {}, 1000);
else createServer((req, res) => {
  res.statusCode = req.url === '/health' ? 200 : 404;
  res.end('ok');
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'preview-supervisor-'));
  await writeFile(join(dir, 'server.mjs'), SERVER);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pidIn(preview: StartedPreview | string): number {
  const text = typeof preview === 'string' ? preview : preview.log();
  return Number(/pid=(\d+)/.exec(text)?.[1]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function start(
  mode: string,
  options: { port?: number; readyTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StartedPreview> {
  const port = options.port ?? (await pickFreeLoopbackPort());
  return await startPreview({
    preview: {
      command: `"${process.execPath}" server.mjs {port} ${mode}`,
      readyPath: '/health',
      uiPaths: [],
      webAppDirs: [],
    },
    port,
    cwd: dir,
    scratchDir: await mkdtemp(join(dir, 'scratch-')),
    bindingId: 'hb',
    ownerRunId: 'run-preview',
    secrets: ['token-abc'],
    signal: options.signal ?? new AbortController().signal,
    readyTimeoutMs: options.readyTimeoutMs ?? 20_000,
    pollMs: 50,
  });
}

describe('a run’s preview', () => {
  it.skipIf(onLoopback.skip)(
    onLoopback.title(
      'starts in the checkout, answers on its ready path, and is stopped with its group',
    ),
    { tags: ['listener'], timeout: 30_000 },
    async () => {
      process.env['AFLOW_PREVIEW_TEST_SECRET'] = 'do-not-pass';
      let preview: StartedPreview;
      try {
        preview = await start('serve');
      } finally {
        delete process.env['AFLOW_PREVIEW_TEST_SECRET'];
      }
      expect(preview.previewUrl).toBe(`http://127.0.0.1:${String(preview.port)}/`);
      const response = await fetch(`${preview.previewUrl}health`);
      expect(await response.text()).toBe('ok');
      const pid = pidIn(preview);
      expect(alive(pid)).toBe(true);

      await preview.stop();
      expect(alive(pid)).toBe(false);
      const log = preview.log();
      expect(log).toContain(`listening on ${String(preview.port)}`);
      expect(log).toContain(`port-env=${String(preview.port)}`);
      // Built from named variables: nothing of the executor's own environment.
      expect(log).toContain('secret=none');
      expect(log).toContain('[redacted] on stderr');
      expect(log).not.toContain('token-abc');
      // Stopping again is a no-op.
      await preview.stop();
    },
  );

  it('fails, naming the command and the last lines it printed, when it never answers', async () => {
    const error = await start('silent', { port: UNUSED_PORTS.silent, readyTimeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PreviewError);
    const message = (error as Error).message;
    expect(message).toContain('server.mjs');
    expect(message).toContain('silent');
    expect(message).toMatch(
      /did not answer at http:\/\/127\.0\.0\.1:\d+\/health or http:\/\/\[::1\]:\d+\/health within 1 s/,
    );
    expect(message).toContain('secret=none');
    // What it printed is carried whole as well, for the run to keep.
    expect((error as PreviewError).log).toContain('secret=none');
    // And it was stopped, not left running.
    expect(alive(pidIn(message))).toBe(false);
  }, 30_000);

  it('fails at once when the command exits before it answers', async () => {
    const port = UNUSED_PORTS.exits;
    const error = await startPreview({
      preview: { command: 'echo boom {port}; exit 3', readyPath: '/', uiPaths: [], webAppDirs: [] },
      port,
      cwd: dir,
      scratchDir: await mkdtemp(join(dir, 'scratch-')),
      bindingId: 'hb',
      ownerRunId: 'run-exit',
      secrets: [],
      signal: new AbortController().signal,
      readyTimeoutMs: 20_000,
      pollMs: 50,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreviewError);
    expect((error as Error).message).toContain(`echo boom ${String(port)}; exit 3`);
    expect((error as Error).message).toContain('exited with 3');
    expect((error as Error).message).toContain(`boom ${String(port)}`);
  }, 30_000);

  it('counts a preview answering on IPv6 loopback alone as ready, and hands over that address', async () => {
    const asked: string[] = [];
    const preview = await startPreview({
      preview: { command: 'serve {port}', readyPath: '/health', uiPaths: [], webAppDirs: [] },
      port: 41_794,
      cwd: dir,
      scratchDir: await mkdtemp(join(dir, 'scratch-')),
      bindingId: 'hb',
      ownerRunId: 'run-v6',
      secrets: [],
      signal: new AbortController().signal,
      pollMs: 10,
      start: standIn(),
      fetch: (url) => {
        asked.push(String(url));
        return String(url).startsWith('http://[::1]:')
          ? Promise.resolve(new Response('ok'))
          : Promise.reject(new Error('ECONNREFUSED'));
      },
    });
    expect(asked).toContain('http://127.0.0.1:41794/health');
    expect(asked).toContain('http://[::1]:41794/health');
    expect(preview.previewUrl).toBe('http://[::1]:41794/');
    await preview.stop();
  });

  it('prefers IPv4 loopback when both answer', async () => {
    const preview = await startPreview({
      preview: { command: 'serve {port}', readyPath: '/', uiPaths: [], webAppDirs: [] },
      port: 41_795,
      cwd: dir,
      scratchDir: await mkdtemp(join(dir, 'scratch-')),
      bindingId: 'hb',
      ownerRunId: 'run-both',
      secrets: [],
      signal: new AbortController().signal,
      pollMs: 10,
      start: standIn(),
      fetch: () => Promise.resolve(new Response('ok')),
    });
    expect(preview.previewUrl).toBe('http://127.0.0.1:41795/');
    await preview.stop();
  });

  it('stops waiting when the run is stopped', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);
    const error = await start('silent', {
      port: UNUSED_PORTS.aborted,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('stopped while its preview was starting');
  }, 30_000);

  it.skipIf(onLoopback.skip)(
    onLoopback.title('ends a group that ignores SIGTERM with SIGKILL, and waits for it'),
    { tags: ['listener'], timeout: 30_000 },
    async () => {
      const preview = await start('stubborn');
      const pid = pidIn(preview);
      const began = Date.now();
      await preview.stop();
      expect(Date.now() - began).toBeGreaterThanOrEqual(4_000);
      expect(alive(pid)).toBe(false);
    },
  );
});

describe('the port a preview is claimed on', () => {
  it('refuses a fixed port another run holds, naming that run, until it is released', async () => {
    const first = await claimPreviewPort({ port: 41_731 }, holder('run-a'), FREE);
    expect(previewPortHolder(41_731)).toEqual(holder('run-a'));
    await expect(claimPreviewPort({ port: 41_731 }, holder('run-b'), FREE)).rejects.toThrow(
      'preview port 41731 is held by run run-a',
    );
    first.release();
    const second = await claimPreviewPort({ port: 41_731 }, holder('run-b'), FREE);
    // The first run's late release frees nothing of the second's.
    first.release();
    expect(previewPortHolder(41_731)?.runId).toBe('run-b');
    second.release();
    expect(previewPortHolder(41_731)).toBeUndefined();
  });

  it('names the holding run to no one outside its workspace', async () => {
    const first = await claimPreviewPort({ port: 41_735 }, holder('run-a'), FREE);
    try {
      for (const other of [holder('run-b', 'space-b'), holder('run-b', 'space-a', 't2')]) {
        const error = await claimPreviewPort({ port: 41_735 }, other, FREE).catch(
          (e: unknown) => e,
        );
        expect((error as PreviewError).kind).toBe('in_use');
        expect((error as Error).message).toContain('preview port 41735 is in use');
        expect((error as Error).message).not.toContain('run-a');
      }
      expect(previewPortHolder(41_735)?.runId).toBe('run-a');
    } finally {
      first.release();
    }
  });

  it('gives a fixed port to one of two runs claiming it at once', async () => {
    let probes = 0;
    const slow = {
      stackOwn: NO_STACK,
      taken: async () => {
        probes += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return false;
      },
    };
    const outcomes = await Promise.allSettled([
      claimPreviewPort({ port: 41_732 }, holder('run-a'), slow),
      claimPreviewPort({ port: 41_732 }, holder('run-b'), slow),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String((lost[0] as PromiseRejectedResult).reason)).toContain('held by run run-a');
    expect(probes).toBe(1);
    (won[0] as PromiseFulfilledResult<{ release(): void }>).value.release();
  });

  it.skipIf(onLoopback.skip)(
    onLoopback.title('refuses a fixed port anything else listens on, and holds nothing for it'),
    { tags: ['listener'] },
    async () => {
      const server: Server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      try {
        await expect(
          claimPreviewPort({ port }, holder('run-a'), { stackOwn: NO_STACK }),
        ).rejects.toThrow(`preview port ${String(port)} is in use`);
        expect(previewPortHolder(port)).toBeUndefined();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

  it('refuses a fixed port this stack serves on', async () => {
    const stackOwn = new Map<number, StackPortOwner>([[3001, { service: 'web', from: 'default' }]]);
    const error = await claimPreviewPort({ port: 3001 }, holder('run-a'), {
      stackOwn,
      taken: () => Promise.resolve(false),
    }).catch((e: unknown) => e);
    expect((error as PreviewError).kind).toBe('stack_port');
    expect((error as Error).message).toContain("Port 3001 is this stack's own");
  });

  it('takes a free port no run holds and this stack does not serve on', async () => {
    const holding = await claimPreviewPort({ port: 41_733 }, holder('run-a'), FREE);
    const offered = [3001, 41_733, 41_734];
    const stackOwn = new Map<number, StackPortOwner>([[3001, { service: 'web', from: 'default' }]]);
    const claim = await claimPreviewPort({}, holder('run-b'), {
      stackOwn,
      taken: () => Promise.resolve(false),
      freePort: () => Promise.resolve(offered.shift() ?? 0),
    });
    expect(claim.port).toBe(41_734);
    claim.release();
    holding.release();
  });

  it('passes over a free IPv4 port that a wildcard or IPv6 listener holds', async () => {
    const offered = [41_736, 41_737];
    const probed: number[] = [];
    const claim = await claimPreviewPort({}, holder('run-a'), {
      stackOwn: NO_STACK,
      // The shared probe binds every stack, wildcard and loopback, IPv4 and IPv6.
      taken: (port) => {
        probed.push(port);
        return Promise.resolve(port === 41_736);
      },
      freePort: () => Promise.resolve(offered.shift() ?? 0),
    });
    expect(probed).toEqual([41_736, 41_737]);
    expect(claim.port).toBe(41_737);
    expect(previewPortHolder(41_736)).toBeUndefined();
    claim.release();
  });

  it.skipIf(onLoopback.skip)(
    onLoopback.title('finds a port held on IPv6 loopback alone taken'),
    { tags: ['listener'] },
    async () => {
      const server: Server = createServer();
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => {
          resolve(false);
        });
        server.listen(0, '::1', () => {
          resolve(true);
        });
      });
      if (!listening) return;
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      try {
        expect(await portTaken(port)).toBe(true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});

describe('the preview’s command and ready address', () => {
  it('puts the port wherever the command names it', () => {
    expect(previewCommand('yarn dev --port {port} --hmr {port}', 5180)).toBe(
      'yarn dev --port 5180 --hmr 5180',
    );
  });

  it('stays on the preview’s own loopback origin', () => {
    expect(previewReadyUrl(5180, '/health').href).toBe('http://127.0.0.1:5180/health');
    expect(previewReadyUrl(5180, '/health', '[::1]').href).toBe('http://[::1]:5180/health');
    for (const path of ['//evil.example/health', '/\\evil.example']) {
      expect(() => previewReadyUrl(5180, path), path).toThrow(PreviewError);
    }
  });
});
