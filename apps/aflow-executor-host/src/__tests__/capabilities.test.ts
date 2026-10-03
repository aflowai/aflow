/**
 * The capability probe is what lets a test be skipped, so it must never answer
 * "available" for a call that is refused: that would turn a refusal back into a
 * failure, or — worse — let a test that needed the call pass without it.
 */
import { EventEmitter } from 'node:events';
import { type FSWatcher, watch } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FILE_WATCHING,
  LOOPBACK_LISTENER,
  probeFileWatching,
  probeLoopbackListener,
  requires,
} from './fixtures/capabilities.js';

function emfile(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('EMFILE: too many open files, watch');
  error.code = 'EMFILE';
  return error;
}

function silentWatcher(): FSWatcher & EventEmitter {
  return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as FSWatcher &
    EventEmitter;
}

/** What the real `fs.watch` does with a write here: reports it, or is refused. */
async function realWatch(): Promise<'reported' | 'refused'> {
  const dir = await mkdtemp(join(tmpdir(), 'aflow-watch-real-'));
  let watcher: FSWatcher | undefined;
  let rewrite: NodeJS.Timeout | undefined;
  try {
    return await new Promise<'reported' | 'refused'>((resolve) => {
      const deadline = setTimeout(() => {
        resolve('refused');
      }, 5_000);
      try {
        watcher = watch(dir);
      } catch {
        clearTimeout(deadline);
        resolve('refused');
        return;
      }
      watcher.on('error', () => {
        clearTimeout(deadline);
        resolve('refused');
      });
      watcher.on('change', () => {
        clearTimeout(deadline);
        resolve('reported');
      });
      rewrite = setInterval(() => {
        void writeFile(join(dir, 'real'), String(Date.now())).catch(() => undefined);
      }, 50);
    });
  } finally {
    if (rewrite !== undefined) clearInterval(rewrite);
    watcher?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function realListen(): Promise<'listening' | 'refused'> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve('refused');
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => {
        resolve('listening');
      });
    });
  });
}

describe('the file-watching probe', () => {
  it('answers refused when the watch call throws', async () => {
    const answer = await probeFileWatching(() => {
      throw emfile();
    });
    expect(answer.available).toBe(false);
    expect(answer.refusal).toContain('EMFILE');
  });

  it('answers refused when the watch returns and then reports the refusal as an error', async () => {
    const answer = await probeFileWatching(() => {
      const watcher = silentWatcher();
      setTimeout(() => watcher.emit('error', emfile()), 10);
      return watcher;
    });
    expect(answer.available).toBe(false);
    expect(answer.refusal).toContain('EMFILE');
  });

  it('answers refused when an armed watch never reports the write', async () => {
    const answer = await probeFileWatching(() => silentWatcher(), 200);
    expect(answer.available).toBe(false);
    expect(answer.refusal).toContain('no change reported');
  });

  it('agrees with what the real call does here', async () => {
    expect(FILE_WATCHING.available).toBe((await realWatch()) === 'reported');
  }, 10_000);
});

describe('the listener probe', () => {
  it('answers refused when listening throws', async () => {
    const answer = await probeLoopbackListener(() => {
      throw Object.assign(new Error('listen EPERM: operation not permitted'), { code: 'EPERM' });
    });
    expect(answer.available).toBe(false);
    expect(answer.refusal).toContain('EPERM');
  });

  it('agrees with what the real call does here', async () => {
    expect(LOOPBACK_LISTENER.available).toBe((await realListen()) === 'listening');
  });
});

describe('a requirement', () => {
  it('names each refused capability in the skipped test’s name', () => {
    const needed = requires(
      { name: 'fs.watch', available: false, refusal: 'EMFILE' },
      { name: 'a loopback listener', available: true },
    );
    expect(needed.skip).toBe(true);
    expect(needed.title('fires')).toBe('fires — skipped: fs.watch refused here (EMFILE)');
  });

  it('leaves the name alone when nothing is refused', () => {
    const needed = requires({ name: 'fs.watch', available: true });
    expect(needed.skip).toBe(false);
    expect(needed.title('fires')).toBe('fires');
  });
});
