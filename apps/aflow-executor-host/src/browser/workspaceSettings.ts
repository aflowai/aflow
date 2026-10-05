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
import type { StackOwnPorts } from './localPorts.js';

export type BrowserSettingRequest = Extract<HostBrowserRequest, { kind: 'setting' }>;

export async function answerBrowserSetting(
  request: BrowserSettingRequest,
  policyPath: string,
  findChrome: () => ChromeDiscovery,
  stackOwn: StackOwnPorts,
): Promise<HostBrowserSettingAnswer> {
  try {
    const { profile } = await changeBrowserSetting(
      policyPath,
      findChrome,
      { ...request.setting, profileId: request.profileId },
      stackOwn,
    );
    return { kind: 'changed', profile };
  } catch (error) {
    return { kind: 'refused', message: errorText(error) };
  }
}

/**
 * The executor's one way to apply the machine page's changes: each waits for
 * the one before it, because each reads the whole policy file and writes it
 * back. The writer's lock keeps the command out meanwhile.
 */
export function browserSettingsInTurn(
  policyPath: string,
  findChrome: () => ChromeDiscovery,
  stackOwn: StackOwnPorts,
): (request: BrowserSettingRequest) => Promise<HostBrowserSettingAnswer> {
  let last: Promise<unknown> = Promise.resolve();
  return (request) => {
    const answer = last.then(
      async () => await answerBrowserSetting(request, policyPath, findChrome, stackOwn),
    );
    last = answer.catch(() => undefined);
    return answer;
  };
}
