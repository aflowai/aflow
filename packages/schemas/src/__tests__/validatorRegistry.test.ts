import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  registerValidator,
  registerRuntimeValidator,
  getValidator,
  getRuntimeValidator,
  lookupValidator,
  listRegisteredValidatorNames,
  _resetValidatorRegistryForTest,
  type RuntimeValidatorIssue,
} from '../runtime/validatorRegistry.js';

describe('validatorRegistry', () => {
  beforeEach(() => {
    _resetValidatorRegistryForTest();
  });

  it('registers and looks up a validator by name', () => {
    const schema = z.object({ x: z.string() });
    registerValidator('my-thing', schema);
    expect(getValidator('my-thing')).toBe(schema);
  });

  it('returns null for unregistered names', () => {
    expect(getValidator('absent')).toBeNull();
  });

  it('is idempotent for the same schema instance', () => {
    const schema = z.object({ x: z.string() });
    registerValidator('thing', schema);
    expect(() => registerValidator('thing', schema)).not.toThrow();
    expect(getValidator('thing')).toBe(schema);
  });

  it('rejects re-registration with a different schema under the same name', () => {
    registerValidator('thing', z.string());
    expect(() => registerValidator('thing', z.number())).toThrow(/already registered/);
  });

  it('lists registered names in sorted order', () => {
    registerValidator('zeta', z.string());
    registerValidator('alpha', z.string());
    registerValidator('mu', z.string());
    expect(listRegisteredValidatorNames()).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('validatorRegistry — runtime validators', () => {
  beforeEach(() => {
    _resetValidatorRegistryForTest();
  });

  it('registers and looks up a runtime validator by name', async () => {
    const fn = async (): Promise<RuntimeValidatorIssue[]> => [];
    registerRuntimeValidator('cap-check', fn);
    expect(getRuntimeValidator('cap-check')).toBe(fn);
  });

  it('lookupValidator discriminates between pure and runtime', () => {
    const pureSchema = z.object({ x: z.string() });
    const runtimeFn = async (): Promise<RuntimeValidatorIssue[]> => [];
    registerValidator('p', pureSchema);
    registerRuntimeValidator('r', runtimeFn);

    const lp = lookupValidator('p');
    const lr = lookupValidator('r');
    expect(lp?.kind).toBe('pure');
    if (lp?.kind === 'pure') expect(lp.schema).toBe(pureSchema);
    expect(lr?.kind).toBe('runtime');
    if (lr?.kind === 'runtime') expect(lr.fn).toBe(runtimeFn);
    expect(lookupValidator('absent')).toBeNull();
  });

  it('rejects registering the same name as both pure and runtime', () => {
    registerValidator('shared', z.string());
    expect(() => registerRuntimeValidator('shared', async () => [])).toThrow(
      /already registered as a pure validator/,
    );

    _resetValidatorRegistryForTest();
    registerRuntimeValidator('shared', async () => []);
    expect(() => registerValidator('shared', z.string())).toThrow(
      /already registered as a runtime validator/,
    );
  });

  it('listRegisteredValidatorNames returns both kinds combined and sorted', () => {
    registerValidator('zeta', z.string());
    registerRuntimeValidator('alpha', async () => []);
    registerValidator('mu', z.string());
    registerRuntimeValidator('beta', async () => []);
    expect(listRegisteredValidatorNames()).toEqual(['alpha', 'beta', 'mu', 'zeta']);
  });
});
