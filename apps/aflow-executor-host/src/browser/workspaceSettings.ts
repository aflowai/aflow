/**
 * A profile's setting changed from the machine page, applied here by the
 * command's own writer: the command and the page cannot validate or write
 * differently, and the policy file keeps one writer on this machine. The
 * request reaches this executor only from the operator routes, which take a
 * person's authenticated request (Plan 320 D5).
 */
import type { HostBrowserRequest, HostBrowserSettingAnswer } from '@aflow/redis';

import { changeBrowserSetting } from './browserCommands.js';
import type { ChromeDiscovery } from './chromeDiscovery.js';
import { errorText } from './errors.js';

export async function answerBrowserSetting(
  request: Extract<HostBrowserRequest, { kind: 'setting' }>,
  policyPath: string,
  findChrome: () => ChromeDiscovery,
): Promise<HostBrowserSettingAnswer> {
  try {
    const { profile } = await changeBrowserSetting(policyPath, findChrome, {
      ...request.setting,
      profileId: request.profileId,
    });
    return { kind: 'changed', profile };
  } catch (error) {
    return { kind: 'refused', message: errorText(error) };
  }
}
