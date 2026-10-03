/**
 * Contract: a compiled policy withholds home, grants only the binding, and
 * never reaches for an option that would void the enforcement it claims.
 *
 * The adapter's own schema validates the shape, so its version bump surfaces
 * here rather than at the first sandboxed command.
 */
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { describe, expect, it } from 'vitest';

import type { HostBinding } from '../bindings.js';
import { FORBIDDEN_SANDBOX_OPTIONS, compileSandboxPolicy } from '../sandboxPolicy.js';

const HOME = '/Users/probe';
const binding: HostBinding = {
  id: 'hb',
  root: '/Users/probe/projects/demo',
  mode: 'readwrite',
  singleFile: false,
};

const compile = (over: Partial<HostBinding> = {}): ReturnType<typeof compileSandboxPolicy> =>
  compileSandboxPolicy({ ...binding, ...over }, { home: HOME, scratchDir: '/tmp/aflow-host' });

describe('what a repository exposes to a confined command', () => {
  // Denying `.git` whole made git unusable: it aborts on an unreadable config,
  // so `log`, `status` and `diff` all failed in a connected repository — which
  // is most of why an operator connects one. The line moved to what actually
  // escalates.
  const hooks = '/Users/probe/projects/demo/.git/hooks';
  const config = '/Users/probe/projects/demo/.git/config';

  it('never lets a command write a program git will run later', () => {
    // `hooks/` and a `filter.*.smudge` defined in `config` both execute as the
    // operator, unconfined, at the next checkout.
    const policy = compile();
    expect(policy.filesystem.denyWrite).toContain(hooks);
    expect(policy.filesystem.denyWrite).toContain(config);
  });

  it('keeps hooks unreadable too, since git does not need them', () => {
    expect(compile().filesystem.denyRead).toContain(hooks);
  });

  it('lets git read its own config, because it will not start otherwise', () => {
    // Measured, not assumed: with `.git/config` unreadable, git exits fatally
    // on `log` and `status` alike.
    expect(compile().filesystem.denyRead).not.toContain(config);
  });

  it('applies the same rule to a nested repository', () => {
    const policy = compile();
    expect(policy.filesystem.denyWrite).toContain('/Users/probe/projects/demo/**/.git/hooks');
    expect(policy.filesystem.denyWrite).toContain('/Users/probe/projects/demo/**/.git/config');
  });

  it('still refuses a read-only binding any write at all', () => {
    expect(compile({ mode: 'read' }).filesystem.allowWrite).not.toContain(binding.root);
  });
});

describe('sandbox policy compilation', () => {
  it('denies the home directory as a region', () => {
    expect(compile().filesystem.denyRead).toContain(HOME);
  });

  it('re-allows the binding root inside the denied region', () => {
    expect(compile().filesystem.allowRead).toContain(binding.root);
  });

  it('grants no write to a read-only binding beyond scratch', () => {
    expect(compile({ mode: 'read' }).filesystem.allowWrite).toEqual(['/tmp/aflow-host']);
  });

  it('grants the binding root to a read-write binding', () => {
    expect(compile().filesystem.allowWrite).toContain(binding.root);
  });

  it('opens no egress by default', () => {
    expect(compile().network.allowedDomains).toEqual([]);
  });

  it('hands a check’s widening no reach to the machine’s loopback', () => {
    const policy = compileSandboxPolicy(binding, {
      home: HOME,
      scratchDir: '/tmp/aflow-host',
      widening: {
        authPaths: [],
        allowedDomains: [],
        writableRoot: '/tmp/aflow-check',
        withholdBindingWrite: true,
      },
    });
    expect(policy.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    expect(() => SandboxRuntimeConfigSchema.parse(policy)).not.toThrow();
  });

  it('never emits an option that voids the contract', () => {
    const serialized = JSON.stringify(compile());
    for (const option of FORBIDDEN_SANDBOX_OPTIONS) {
      expect(serialized).not.toContain(option);
    }
  });

  it('produces a policy the adapter itself accepts', () => {
    // Guards against the adapter's schema moving under a pinned beta.
    expect(() => SandboxRuntimeConfigSchema.parse(compile())).not.toThrow();
  });
});
