import { describe, it, expect, vi } from 'vitest';
import { globalErrorHandler } from '../errorHandler.js';
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
  classifyRunServiceError,
  PublicError,
} from '../errors.js';
import { classifyDbError, isDatabaseError } from '../databaseErrors.js';
import { PermissionDeniedError } from '@aflow/authz';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRequest(): FastifyRequest {
  return {
    id: 'req-123',
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as FastifyRequest;
}

function mockReply(): FastifyReply & { _status: number; _body: unknown } {
  const reply = {
    _status: 0,
    _body: null as unknown,
    status(code: number) {
      reply._status = code;
      return reply;
    },
    send(body: unknown) {
      reply._body = body;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { _status: number; _body: unknown };
}

// ---------------------------------------------------------------------------
// PublicError subclasses
// ---------------------------------------------------------------------------

describe('PublicError subclasses', () => {
  it('BadRequestError has statusCode 400', () => {
    const err = new BadRequestError('Invalid input');
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('BadRequest');
    expect(err.message).toBe('Invalid input');
    expect(err).toBeInstanceOf(PublicError);
  });

  it('NotFoundError has statusCode 404', () => {
    const err = new NotFoundError('Run not found');
    expect(err.statusCode).toBe(404);
    expect(err.errorCode).toBe('NotFound');
  });

  it('ConflictError has statusCode 409', () => {
    const err = new ConflictError('Already exists');
    expect(err.statusCode).toBe(409);
    expect(err.errorCode).toBe('Conflict');
  });

  it('TooManyRequestsError has statusCode 429', () => {
    const err = new TooManyRequestsError('Slow down');
    expect(err.statusCode).toBe(429);
    expect(err.errorCode).toBe('TooManyRequests');
  });

  it('BadRequestError accepts custom error code', () => {
    const err = new BadRequestError('Import failed', 'ImportFailed');
    expect(err.errorCode).toBe('ImportFailed');
  });
});

// ---------------------------------------------------------------------------
// classifyRunServiceError
// ---------------------------------------------------------------------------

describe('classifyRunServiceError', () => {
  it('maps "not found" to NotFoundError', () => {
    const err = classifyRunServiceError(new Error('Run abc not found'));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.statusCode).toBe(404);
  });

  it('maps "not paused" to ConflictError', () => {
    const err = classifyRunServiceError(new Error('Run abc is not paused'));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.statusCode).toBe(409);
  });

  it('maps "mismatch" to ConflictError', () => {
    const err = classifyRunServiceError(new Error('Resume mismatch'));
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('maps 429 statusCode to TooManyRequestsError', () => {
    const err = Object.assign(new Error('Rate limited'), { statusCode: 429 });
    const result = classifyRunServiceError(err);
    expect(result).toBeInstanceOf(TooManyRequestsError);
    expect(result.statusCode).toBe(429);
  });

  it('defaults to BadRequestError for unknown messages', () => {
    const err = classifyRunServiceError(new Error('Something else'));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.statusCode).toBe(400);
  });

  it('handles non-Error input', () => {
    const err = classifyRunServiceError('string error');
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toBe('Unknown error');
  });
});

// ---------------------------------------------------------------------------
// isDatabaseError
// ---------------------------------------------------------------------------

describe('isDatabaseError', () => {
  it('detects "Failed query:" messages', () => {
    expect(isDatabaseError(new Error('Failed query: INSERT INTO ...'))).toBe(true);
  });

  it('detects "duplicate key" messages', () => {
    expect(isDatabaseError(new Error('duplicate key value violates unique constraint'))).toBe(true);
  });

  it('detects "relation" messages', () => {
    expect(isDatabaseError(new Error('relation "provider_credentials" does not exist'))).toBe(true);
  });

  it('does not match normal errors', () => {
    expect(isDatabaseError(new Error('Something went wrong'))).toBe(false);
  });

  it('does not match non-Error values', () => {
    expect(isDatabaseError('just a string')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyDbError
// ---------------------------------------------------------------------------

describe('classifyDbError', () => {
  it('returns ServiceUnavailable for missing table', () => {
    const err = classifyDbError(
      new Error('relation "provider_credentials" does not exist'),
      'save credential',
    );
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain('not initialized');
    // Must NOT contain the original table name
    expect(err.message).not.toContain('provider_credentials');
  });

  it('returns Conflict for duplicate key', () => {
    const err = classifyDbError(
      new Error('duplicate key value violates unique constraint "flows_pkey"'),
      'create flow',
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('already exists');
    // Must NOT contain the constraint name
    expect(err.message).not.toContain('flows_pkey');
  });

  it('returns generic 500 for unknown DB errors', () => {
    const err = classifyDbError(new Error('Failed query: SELECT * FROM ...'), 'load data');
    expect(err.statusCode).toBe(500);
    expect(err.message).toContain('Failed to load data');
    // Must NOT contain SQL
    expect(err.message).not.toContain('SELECT');
  });
});

// ---------------------------------------------------------------------------
// globalErrorHandler
// ---------------------------------------------------------------------------

describe('globalErrorHandler', () => {
  it('exposes PublicError message', () => {
    const req = mockRequest();
    const reply = mockReply();
    const err = new BadRequestError('Invalid flow ID');

    globalErrorHandler(err, req, reply as unknown as FastifyReply);

    expect(reply._status).toBe(400);
    expect((reply._body as { error: string; message: string }).error).toBe('BadRequest');
    expect((reply._body as { error: string; message: string }).message).toBe('Invalid flow ID');
  });

  it('handles PermissionDeniedError', () => {
    const req = mockRequest();
    const reply = mockReply();
    const err = new PermissionDeniedError('run', 'write');

    globalErrorHandler(err, req, reply as unknown as FastifyReply);

    expect(reply._status).toBe(403);
    expect((reply._body as { error: string }).error).toBe('Forbidden');
  });

  it('passes through Fastify 4xx errors', () => {
    const req = mockRequest();
    const reply = mockReply();
    const err = Object.assign(new Error('Bad Request'), {
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
    }) as FastifyError;

    globalErrorHandler(err, req, reply as unknown as FastifyReply);

    expect(reply._status).toBe(400);
    expect((reply._body as { error: string }).error).toBe('FST_ERR_VALIDATION');
  });

  it('scrubs database errors', () => {
    const req = mockRequest();
    const reply = mockReply();
    const err = new Error(
      'Failed query: INSERT INTO provider_credentials (id, secret) VALUES ($1, $2) params: ["abc", "sk-secret-key"]',
    );

    globalErrorHandler(err as FastifyError, req, reply as unknown as FastifyReply);

    const body = reply._body as { error: string; message: string; supportRef: string };
    expect(reply._status).toBe(500);
    expect(body.message).not.toContain('INSERT');
    expect(body.message).not.toContain('params');
    expect(body.message).not.toContain('sk-secret-key');
    expect(body.supportRef).toBe('req-123');
  });

  it('scrubs unknown errors with supportRef', () => {
    const req = mockRequest();
    const reply = mockReply();
    const err = new Error('Redis connection refused at 10.0.0.1:6379');

    globalErrorHandler(err as FastifyError, req, reply as unknown as FastifyReply);

    const body = reply._body as { error: string; message: string; supportRef: string };
    expect(reply._status).toBe(500);
    expect(body.error).toBe('InternalError');
    expect(body.message).not.toContain('Redis');
    expect(body.message).not.toContain('10.0.0.1');
    expect(body.supportRef).toBe('req-123');
  });

  it('never leaks SQL substrings in any error path', () => {
    const dangerousMessages = [
      'Failed query: SELECT * FROM users WHERE id = $1',
      'duplicate key value violates unique constraint "users_email_key"',
      'insert into sessions (token, user_id) values ($1, $2)',
      'PostgresError: relation "tenants" does not exist',
      'params: ["password123", "admin@example.com"]',
    ];

    const forbiddenSubstrings = [
      'Failed query:',
      'SELECT',
      'INSERT',
      'insert into',
      'params:',
      'password123',
      'admin@example.com',
      'users_email_key',
    ];

    for (const msg of dangerousMessages) {
      const req = mockRequest();
      const reply = mockReply();
      globalErrorHandler(new Error(msg) as FastifyError, req, reply as unknown as FastifyReply);

      const body = reply._body as { message: string };
      for (const forbidden of forbiddenSubstrings) {
        expect(body.message).not.toContain(forbidden);
      }
    }
  });
});
