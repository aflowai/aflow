/**
 * Contract: a binding reaches only the workspace it was connected for.
 *
 * A binding id is addressable by anything that can reach this executor, so
 * without this a second workspace on the same appliance could name another's
 * binding and reach that folder — and deleting the appliance-side row revoked
 * nothing, because the appliance-side row was never what authorised the call.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HostBindingError, HostBindingSchema, requireSpace } from '../bindings.js';

const SRC = join(fileURLToPath(new URL('../', import.meta.url)));

function handlerFiles(): string[] {
  const dir = join(SRC, 'handlers');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

const bound = (spaceId?: string) =>
  HostBindingSchema.parse({
    id: 'hb',
    root: '/tmp/x',
    mode: 'read',
    allowsExecution: false,
    ...(spaceId !== undefined ? { spaceId } : {}),
  });

describe('a binding belongs to one workspace', () => {
  it('admits the workspace it was connected for', () => {
    expect(() => {
      requireSpace(bound('space-a'), 'space-a');
    }).not.toThrow();
  });

  it('refuses another workspace naming the same binding id', () => {
    expect(() => {
      requireSpace(bound('space-a'), 'space-b');
    }).toThrow(HostBindingError);
  });

  it('does not name the workspace it does belong to', () => {
    // Naming it would confirm which id is worth guessing next.
    try {
      requireSpace(bound('space-a'), 'space-b');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('space-a');
    }
  });

  it('fails closed for a policy written before this was recorded', () => {
    // A binding that cannot say which workspace it belongs to belongs to none,
    // and the message says what to do about it.
    try {
      requireSpace(bound(undefined), 'space-a');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('Reconnect');
    }
  });

  it('fails closed when the job names no workspace at all', () => {
    expect(() => {
      requireSpace(bound('space-a'), undefined);
    }).toThrow(HostBindingError);
  });
});

describe('no handler resolves a binding without checking its workspace', () => {
  it('every handler that calls requireBinding also calls requireSpace', () => {
    // The check is easy to forget in a new handler, and forgetting it is silent
    // — the operation works, for the wrong workspace.
    const missing = handlerFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('requireBinding') && !source.includes('requireSpace');
      })
      .map((file) => file.slice(SRC.length));
    expect(missing).toEqual([]);
  });

  it('the handler that shares a resolver still checks it', () => {
    // hostHandler dispatches rather than resolving, so it is exempt by having
    // no requireBinding at all — asserted so the exemption stays honest.
    const source = readFileSync(join(SRC, 'handlers', 'hostHandler.ts'), 'utf8');
    expect(source).not.toContain('requireBinding');
  });
});
