import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Fastify does not export its own; structurally identical. */
type ParserDone = (err: Error | null, body?: unknown) => void;

/**
 * `FastifyBodyParser` unions a callback-style parser with a promise-style one.
 * The default JSON parser is the callback arm — it returns nothing and reports
 * through `done` — so naming that arm is what lets the call be read as
 * complete rather than as a dropped promise.
 */
type CallbackJsonParser = (request: FastifyRequest, rawBody: string, done: ParserDone) => void;

export interface JsonBodyParserOptions {
  /**
   * Receives the exact octets that arrived, before parsing. A caller that
   * authenticates the body — an HMAC over the delivered bytes — cannot
   * re-derive them from the parsed value, because `JSON.stringify` of that
   * value differs from the sender's text whenever key order, whitespace,
   * escaping or number formatting differ.
   */
  onRawBody?: (request: FastifyRequest, raw: Buffer) => void;
}

/**
 * Installs the JSON body parser: Fastify's own, with one relaxation — an empty
 * body parses to `undefined`, so a DELETE may set `Content-Type:
 * application/json` and send nothing.
 *
 * The relaxation is the only intended difference, so the parser delegates
 * rather than calling `JSON.parse` itself. Two upstream guarantees ride on
 * that. `__proto__` and `constructor.prototype` in a body are refused instead
 * of reaching application code; and malformed input raises
 * `FST_ERR_CTP_INVALID_JSON_BODY`, which carries a 400 — a bare `SyntaxError`
 * carries no status, and `globalErrorHandler` answers a status-less error with
 * 500, which would report a malformed client body as a server fault.
 */
export function registerJsonBodyParser(
  app: FastifyInstance,
  options: JsonBodyParserOptions = {},
): void {
  const parseJson = app.getDefaultJsonParser('error', 'error') as CallbackJsonParser;
  const { onRawBody } = options;

  const parse = (request: FastifyRequest, text: string, done: ParserDone): void => {
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    parseJson(request, text, done);
  };

  if (onRawBody) {
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request, body: Buffer, done) => {
        onRawBody(request, body);
        parse(request, body.toString('utf8'), done);
      },
    );
    return;
  }

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    parse(request, body as string, done);
  });
}
