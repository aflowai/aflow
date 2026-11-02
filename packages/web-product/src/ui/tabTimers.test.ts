/**
 * A tab reads on events or on the operator's action, never on a timer.
 *
 * Every `setInterval` call and every `refetchInterval` a query is handed in the
 * shared product and the local application must belong to an entry below. Each
 * entry names one timer the way the background-work registry names a service's
 * loop, and says why no event the page holds can replace it. A timer missing
 * from the list fails, and so does an entry whose timer has gone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ROOTS = ['packages/web-product/src/ui', 'apps/web-local/src'];

type TabTimerMechanism = 'setInterval' | 'refetchInterval';

interface TabTimer {
  /** `web.<snake_case>`, unique. */
  readonly id: string;
  /** Repository-relative path of the file that holds the timer. */
  readonly site: string;
  readonly mechanism: TabTimerMechanism;
  /** Occurrences of the mechanism this entry owns in its file. */
  readonly count: number;
  /** Why this is a timer and not an event the page already holds. */
  readonly reason: string;
  /** When the timer runs, and what stops it. */
  readonly bound: string;
}

const TAB_TIMERS: readonly TabTimer[] = [
  {
    id: 'web.eval_batch_live_refetch',
    site: 'packages/web-product/src/ui/components/evals-tab/EvalsTab.tsx',
    mechanism: 'refetchInterval',
    count: 1,
    reason:
      "The eval batch engine grades trials and closes the batch in its own pass, and neither write emits an event. A trial's entity.run.updated arrives before its grade exists, so a read on it shows the trial ungraded.",
    bound:
      "Every 5 seconds while the batch list last read the selected batch as queued, running or cancelling. That list refreshes on mount, on focus and on the operator's cancel.",
  },
  {
    id: 'web.host_browser_window_watch',
    site: 'packages/web-product/src/ui/components/host/HostBrowserProfiles.tsx',
    mechanism: 'refetchInterval',
    count: 1,
    reason:
      'The paired machine republishes its browser inventory into the host status as a window opens and closes. No event carries that change to the page.',
    bound:
      'Every 3 seconds while a profile window is open, or for up to 60 seconds while the page waits for a window the operator asked for.',
  },
  {
    id: 'web.local_model_download_poll',
    site: 'packages/web-product/src/ui/hooks/useLocalModels.ts',
    mechanism: 'refetchInterval',
    count: 1,
    reason:
      "Download progress lives in the local model runtime's pull, which the API reads on request. Nothing emits an event as the bytes arrive.",
    bound: 'Every 2 seconds while a model of the space reports a download in progress.',
  },
  {
    id: 'web.memory_reindex_poll',
    site: 'packages/web-product/src/ui/hooks/use-memory-embedding.ts',
    mechanism: 'refetchInterval',
    count: 1,
    reason:
      'Documents are embedded with no event, so the pending count of a re-index changes only on a read.',
    bound: 'Every 5 seconds while the last answer counts documents still waiting to be embedded.',
  },
  {
    id: 'web.orchestrator_health_poll',
    site: 'packages/web-product/src/ui/hooks/use-orchestrator-health.ts',
    mechanism: 'refetchInterval',
    count: 1,
    reason:
      "A stopped orchestrator cannot announce that it is gone. The API serves the event stream and keeps answering without one, so only a read of the orchestrators' leases shows the lapse.",
    bound:
      "Every 15 seconds, half the orchestrator's 30-second lease, while a chat screen's connection notice is mounted.",
  },
  {
    id: 'web.session_presence_heartbeat',
    site: 'packages/web-product/src/ui/hooks/use-session-presence.ts',
    mechanism: 'setInterval',
    count: 1,
    reason:
      "It sends and reads nothing. The heartbeat keeps the tab's presence entry alive, so its absence is the signal that the viewer left. It also carries whether the tab is still typing.",
    bound:
      'One per open session per tab, every 15 seconds inside the 45-second presence TTL. It stops with the subscription.',
  },
  {
    id: 'web.oauth_popup_close_watch',
    site: 'packages/web-product/src/ui/lib/oauthConsentPopup.ts',
    mechanism: 'setInterval',
    count: 1,
    reason:
      'The browser fires no event when the user closes a window the page opened. Reading popup.closed is the only way to learn it, and it calls no API.',
    bound:
      'One per consent popup, every 600 milliseconds. It stops when the popup closes or the component unmounts.',
  },
  {
    id: 'web.realtime_socket_ping',
    site: 'packages/web-product/src/ui/lib/realtimeClient.ts',
    mechanism: 'setInterval',
    count: 1,
    reason:
      'A protocol keepalive on the one realtime socket, which reads nothing. It keeps an idle socket open through proxies and lets a dead one show.',
    bound: 'One per tab, every 25 seconds while the socket is open.',
  },
  {
    id: 'web.api_query_refetch_interval',
    site: 'packages/web-product/src/ui/hooks/useApiQuery.ts',
    mechanism: 'refetchInterval',
    count: 2,
    reason:
      'The option the kept reads above pass, declared once and handed to TanStack once. It reads nothing without a caller, and it stays while any caller on this list stays.',
    bound: 'None of its own. Each caller is an entry with its own bound.',
  },
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (['node_modules', 'dist', '.next', '__tests__', '__mocks__'].includes(entry.name)) return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

/**
 * A `setInterval` call, bare or through an object, and a `refetchInterval`
 * named as a property or a shorthand. Read from the syntax tree, so a comment,
 * a string, a `typeof setInterval` or a read of `opts.refetchInterval` is not a
 * timer.
 */
function timersIn(file: string): TabTimerMechanism[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: TabTimerMechanism[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (node.text === 'setInterval') {
        const callee =
          ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
        const call = callee.parent;
        if (ts.isCallExpression(call) && call.expression === callee) found.push('setInterval');
      } else if (node.text === 'refetchInterval') {
        const isRead = ts.isPropertyAccessExpression(parent) && parent.name === node;
        if (!isRead) found.push('refetchInterval');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function key(site: string, mechanism: TabTimerMechanism): string {
  return `${site} (${mechanism})`;
}

const files = ROOTS.flatMap((root) => sourceFiles(join(REPO, root)));
const relPath = (file: string): string => relative(REPO, file).split(sep).join('/');

const actual = new Map<string, number>();
for (const file of files) {
  for (const mechanism of timersIn(file)) {
    const k = key(relPath(file), mechanism);
    actual.set(k, (actual.get(k) ?? 0) + 1);
  }
}

const declared = new Map<string, number>();
for (const timer of TAB_TIMERS) {
  const k = key(timer.site, timer.mechanism);
  declared.set(k, (declared.get(k) ?? 0) + timer.count);
}

describe('tab timers', () => {
  it('walks both trees', () => {
    // A root that resolves to nothing passes every other assertion here.
    for (const root of ROOTS) {
      expect(existsSync(join(REPO, root)), root).toBe(true);
    }
    expect(files.length).toBeGreaterThan(200);
    expect(actual.size).toBeGreaterThan(0);
  });

  it('names every entry once, with its reason and its bound', () => {
    const ids = TAB_TIMERS.map((timer) => timer.id);
    expect(new Set(ids).size).toBe(ids.length);
    const malformed = TAB_TIMERS.filter(
      (timer) =>
        !/^web\.[a-z]+(?:_[a-z]+)*$/.test(timer.id) ||
        timer.count < 1 ||
        timer.reason.trim().length === 0 ||
        timer.bound.trim().length === 0,
    ).map((timer) => timer.id);
    expect(malformed).toEqual([]);
  });

  it('matches every timer in the tree against an entry', () => {
    const mismatches = [...new Set([...actual.keys(), ...declared.keys()])]
      .sort()
      .filter((k) => (actual.get(k) ?? 0) !== (declared.get(k) ?? 0))
      .map(
        (k) =>
          `${k}: found ${String(actual.get(k) ?? 0)}, declared ${String(declared.get(k) ?? 0)}`,
      );
    expect(
      mismatches,
      "A tab reads on events or on the operator's action, never on a timer. Read on an event " +
        'the page already holds. A timer that has to stay needs an entry in TAB_TIMERS with the ' +
        'reason no event can replace it. An entry for one timer in a file does not cover a second.',
    ).toEqual([]);
  });
});
