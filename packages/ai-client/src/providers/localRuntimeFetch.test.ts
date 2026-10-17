import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { localRuntimeFetch } from './localRuntimeFetch.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('localRuntimeFetch', () => {
  it('reaches a real server on this Node, whatever undici Node bundles', async () => {
    const base = await serve((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body }));
      });
    });

    const res = await localRuntimeFetch(`${base}/api/chat`, { method: 'POST', body: '{"a":1}' });

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ method: 'POST', body: '{"a":1}' });
  });

  it('streams a body as it arrives', async () => {
    const base = await serve((_req, res) => {
      res.write('{"status":"pulling"}\n');
      setTimeout(() => res.end('{"status":"success"}\n'), 20);
    });

    const res = await localRuntimeFetch(`${base}/api/pull`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }

    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('ends on the caller’s signal, the only limit it keeps', async () => {
    const base = await serve(() => undefined);

    await expect(
      localRuntimeFetch(`${base}/api/chat`, { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/) });
  });
});
