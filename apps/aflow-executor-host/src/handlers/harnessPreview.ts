/**
 * What stands between a harness run and the browser and preview it asked for
 * (Plan 320 D19, D21), in the words the run is refused in — or, for a preview
 * asked for `'if_available'` by a skill's rule, the words its result carries
 * in `previewUnavailable` when the run goes on without them.
 */
import type { HostBinding } from '../bindings.js';
import { assertTakesMcpConfig, type HarnessProfile } from '../harnessProfiles.js';
import type { PreviewError } from '../previewSupervisor.js';

/** At most this much of a preview's failure is carried as its one line. */
const PREVIEW_UNAVAILABLE_MAX_CHARS = 1_000;

/** Why the run cannot be given a browser here, or nothing where it can. */
export function browserRefusal(profile: HarnessProfile, served: boolean): string | undefined {
  try {
    assertTakesMcpConfig(profile);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!served) {
    return (
      'This executor serves no browser, so the run cannot be given one. Send the task ' +
      'without `browser`.'
    );
  }
  return undefined;
}

/** Why the folder's preview cannot be started for the run, or nothing where it can. */
export function previewRefusal(
  binding: Pick<HostBinding, 'id' | 'preview'>,
  served: boolean,
): string | undefined {
  if (!served) {
    return (
      'This executor serves no browser, so the run cannot be shown its preview. Send the ' +
      'task without `preview` and `browser`.'
    );
  }
  if (binding.preview === undefined) {
    return (
      `\`${binding.id}\` declares no preview, so there is none to start. A person declares ` +
      `one on the machine — \`aflow folder ${binding.id} preview --command "…"\` — or on ` +
      'the machine page; until then send the task without `preview`.'
    );
  }
  return undefined;
}

/**
 * A preview that could not be had, as the one line a best-effort run's result
 * carries: its first line, without the tail of what it printed, which is the
 * run's `previewLog`.
 */
export function previewUnavailableLine(error: PreviewError): string {
  const first = error.message.split('\n', 1)[0] ?? error.message;
  const line = first.replace(/\s*The last lines it printed:\s*$/, '');
  const withLog = error.log !== undefined ? `${line} What it printed is in \`previewLog\`.` : line;
  return withLog.length > PREVIEW_UNAVAILABLE_MAX_CHARS
    ? `${withLog.slice(0, PREVIEW_UNAVAILABLE_MAX_CHARS - 1)}…`
    : withLog;
}
