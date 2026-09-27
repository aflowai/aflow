/**
 * Every subscriber connection in the server is minted through the shared helper.
 *
 * A connection that only subscribes needs two things an ordinary one does not,
 * and both are invisible until something goes wrong. `enableReadyCheck` issues
 * `INFO` on connect, which a connection already in subscriber mode rejects — so
 * a reconnect raises an error that says nothing about its health. And with no
 * `error` listener ioredis logs its own unhandled-error line, which makes a real
 * failure indistinguishable from that benign one.
 *
 * Both are properties of how the connection is *built*, so the only durable way
 * to hold them is to have one place that builds them.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SERVER_SRC = new URL('../../../', import.meta.url).pathname;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield full;
    }
  }
}

describe('subscriber connections', () => {
  it('are built through createSubscriberConnection, never ad hoc', async () => {
    const offenders: string[] = [];

    for await (const file of walk(SERVER_SRC)) {
      const raw = await readFile(file, 'utf8');
      const rel = file.slice(SERVER_SRC.length);
      // Comments describe these calls as often as they make them.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

      // `.duplicate()` inherits the parent's ready check, and a bare
      // createRedisConnection carries no error guard. Either is fine for a
      // connection that issues commands; neither is fine for one that subscribes.
      const subscribes = /\.(p?subscribe)\s*\(|subscribeTo[A-Z]/.test(src);
      if (!subscribes) continue;
      if (/\.duplicate\s*\(/.test(src)) offenders.push(`${rel} — redis.duplicate()`);
      if (/(?<!createSubscriber)createRedisConnection\s*\(/.test(src)) {
        offenders.push(`${rel} — createRedisConnection()`);
      }
    }

    expect(
      offenders,
      'Mint subscriber connections with createSubscriberConnection() from @aflow/redis.',
    ).toEqual([]);
  });
});
