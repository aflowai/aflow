/**
 * Contract: the loopback ports a harness's ephemeral browser may load are
 * declared on the machine, default to none, and declaring one the appliance
 * may be serving warns in one line (Plan 320 D12).
 */
import { describe, expect, it } from 'vitest';

import { appliancePortWarning, parseLocalPorts } from '../browserLocalPorts.js';
import { HarnessProfileSchema } from '../harnessProfiles.js';

describe('a harness’s browser ports', () => {
  it('are none by default, and only whole port numbers are taken', () => {
    expect(
      HarnessProfileSchema.parse({ id: 'claude', executable: 'claude' }).browserLocalPorts,
    ).toEqual([]);
    expect(parseLocalPorts(['5173', '8080'])).toEqual({ ok: true, ports: [5173, 8080] });
    for (const word of ['0', '65536', '51.73', '-1', 'localhost:5173', '']) {
      expect(parseLocalPorts([word]), word).toEqual({ ok: false, word });
    }
    expect(() =>
      HarnessProfileSchema.parse({ id: 'claude', executable: 'claude', browserLocalPorts: [0] }),
    ).toThrow();
  });

  it('warn in one line when a declared port is the appliance’s by default', () => {
    const warning = appliancePortWarning('claude', [5173, 3001], {});
    expect(warning).toBeDefined();
    expect(warning?.split('\n')).toHaveLength(1);
    expect(warning).toContain("3001 (the appliance's web port by default)");
    expect(warning).not.toContain('5173');
    expect(appliancePortWarning('claude', [3000], {})).toContain('API port by default');
    expect(appliancePortWarning('claude', [5173, 8080], {})).toBeUndefined();
  });

  it('warn about the API port the environment names for the appliance', () => {
    const env = { AFLOW_API_URL: 'http://127.0.0.1:4100' };
    expect(appliancePortWarning('claude', [4100], env)).toContain('as AFLOW_API_URL names it');
    expect(appliancePortWarning('claude', [4100], {})).toBeUndefined();
  });
});
