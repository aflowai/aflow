import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerJsonBodyParser } from '../jsonBodyParser.js';

async function buildApp(onRawBody?: (req: unknown, raw: Buffer) => void) {
  const app = Fastify({ logger: false });
  registerJsonBodyParser(app, onRawBody ? { onRawBody: onRawBody as never } : {});
  app.post('/echo', async (request) => ({ body: request.body ?? null }));
  await app.ready();
  return app;
}

async function post(app: Awaited<ReturnType<typeof buildApp>>, payload: string) {
  return app.inject({
    method: 'POST',
    url: '/echo',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

describe('registerJsonBodyParser', () => {
  it('parses a valid body', async () => {
    const app = await buildApp();
    const res = await post(app, '{"a":1}');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { a: 1 } });
    await app.close();
  });

  it('accepts an empty body as undefined', async () => {
    const app = await buildApp();
    const res = await post(app, '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
    await app.close();
  });

  it('accepts a whitespace-only body as undefined', async () => {
    const app = await buildApp();
    const res = await post(app, '   ');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
    await app.close();
  });

  // A bare SyntaxError carries no statusCode, and globalErrorHandler answers a
  // status-less error with 500 — reporting a malformed client body as a server
  // fault, and raising it to Sentry as unhandled.
  it('answers 400, not 500, on a malformed body', async () => {
    const app = await buildApp();
    const res = await post(app, '34.107.173.4');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_JSON_BODY' });
    await app.close();
  });

  it('rejects a __proto__ key', async () => {
    const app = await buildApp();
    const res = await post(app, '{"__proto__":{"polluted":"yes"}}');
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    await app.close();
  });

  it('rejects a constructor.prototype key', async () => {
    const app = await buildApp();
    const res = await post(app, '{"constructor":{"prototype":{"polluted":"yes"}}}');
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // Only `constructor.prototype` is poisoning; a field merely named
  // `constructor` is ordinary data, and a JSON Schema may declare one.
  it('accepts a plain field named constructor', async () => {
    const app = await buildApp();
    const res = await post(app, '{"properties":{"constructor":{"type":"string"}}}');
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  describe('onRawBody', () => {
    it('receives the exact octets, before parsing', async () => {
      const seen: Buffer[] = [];
      const app = await buildApp((_req, raw) => seen.push(raw));
      const payload = '{"b":2,  "a":1}';
      const res = await post(app, payload);
      expect(res.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      // Byte-identical: an HMAC over a re-serialization would not match.
      expect(seen[0]?.toString('utf8')).toBe(payload);
      await app.close();
    });

    it('still receives the octets when the body is malformed', async () => {
      const seen: Buffer[] = [];
      const app = await buildApp((_req, raw) => seen.push(raw));
      const res = await post(app, 'not json');
      expect(res.statusCode).toBe(400);
      expect(seen[0]?.toString('utf8')).toBe('not json');
      await app.close();
    });
  });
});
