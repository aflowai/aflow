/**
 * @vitest-environment jsdom
 */
/**
 * The chat page's landing (Plan 338 D3, D4), rendered whole with only the
 * network, the realtime client and the router replaced: where the Workbench
 * dock lands, which conversation `/chat` lands on, and what the open dock
 * reads. Every HTTP read and realtime subscription the page makes is counted.
 */
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKBENCH_COLLAPSED_STORAGE_KEY } from '../lib/workbench-dock-memory.js';
import { WORKBENCH_HELD_STORAGE_KEY } from '../lib/workbench-held-sections.js';
import { __resetForTests as resetActionCenterBroker } from '../hooks/action-center-broker.js';
import { __resetForTests as resetCoachSurfaceBroker } from '../hooks/coach-surface-broker.js';
import { __resetForTests as resetEntityEventsBroker } from '../hooks/entity-events-broker.js';
import { __resetForTests as resetMediaBytesBroker } from '../hooks/media-bytes-broker.js';
import { __resetForTests as resetSessionEventsBroker } from '../hooks/session-events-broker.js';
import { __resetForTests as resetWorkbenchFolds } from '../components/workbench/WorkbenchSection.js';
import { ThemeProvider } from '../providers/theme.js';
import { ChatPage } from './space-chat.js';

const SPACE = '00000000-0000-4000-8000-000000000338';
const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000cc';
const SESSION = '00000000-0000-4000-8000-0000000000bb';
const GONE = '00000000-0000-4000-8000-0000000000dd';
const COACH = '00000000-0000-4000-8000-0000000000ee';
const HOUR = 3_600_000;

const net = vi.hoisted(() => ({
  reads: [] as string[],
  topics: [] as string[],
  search: '',
  replaced: [] as string[],
  pushed: [] as string[],
  sessions: [] as Array<Record<string, unknown>>,
  failSessionList: false,
  agents: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  workflows: [] as Array<Record<string, unknown>>,
  coach: null as Record<string, unknown> | null,
  actionItems: [] as Array<Record<string, unknown>>,
  integrations: false,
  plan: null as Record<string, unknown> | null,
  surfaceGate: null as Promise<void> | null,
  listeners: new Map<string, Array<(event: unknown, cursor: string) => void>>(),
}));

const HELMSMAN = {
  agentId: 'h',
  name: 'Helmsman',
  latestVersion: '1',
  systemRole: 'cybernetic-helmsman',
};

const router = {
  replace: (url: string) => {
    net.replaced.push(url);
    net.search = url.split('?')[1] ?? '';
  },
  push: (url: string) => {
    net.pushed.push(url);
    net.search = url.split('?')[1] ?? '';
  },
  prefetch: () => undefined,
};
let params: { search: string; value: URLSearchParams } | null = null;
function searchParams(): URLSearchParams {
  if (params?.search !== net.search) {
    params = { search: net.search, value: new URLSearchParams(net.search) };
  }
  return params.value;
}

vi.mock('next/navigation', () => ({
  useSearchParams: searchParams,
  useRouter: () => router,
  usePathname: () => '/s/demo/chat',
  useParams: () => ({ space: 'demo' }),
}));

function respond(path: string): unknown {
  if (path.endsWith('/users/me')) {
    return { user: { userId: USER, email: 'a@example.com', displayName: 'A' } };
  }
  if (path.endsWith('/agents')) return { agents: net.agents };
  if (path.includes('/workflow-runs?')) {
    return { runs: net.runs, counts: { running: 0, paused: 0 }, nextCursor: null };
  }
  if (path.endsWith('/cybernetic/active-surface')) {
    return net.coach
      ? {
          spaceId: SPACE,
          capturedFrom: 'live',
          helmsman: { sessionId: null, lifecycle: 'unknown' },
          surfacedRuns: [],
          recentTransitions: [],
          coach: net.coach,
        }
      : undefined;
  }
  if (path.includes('/workflows?archived=true')) return { workflows: net.workflows };
  if (path.includes('/sessions?')) return net.failSessionList ? FAILED : { sessions: net.sessions };
  const direct = net.sessions.find((s) => path.endsWith(`/sessions/${String(s['sessionId'])}`));
  if (direct) return direct;
  if (path.includes('/action-center')) {
    const kind = new URLSearchParams(path.split('?')[1] ?? '').get('kind');
    return { items: net.actionItems.filter((item) => !kind || item['kind'] === kind) };
  }
  if (net.integrations) {
    if (path.endsWith('/integrations/mcp/servers')) {
      return { definitions: [{ serverId: 'docs', name: 'Docs' }] };
    }
    if (path.endsWith('/integrations/mcp/bindings')) {
      return {
        bindings: [{ serverId: 'docs', authType: 'bearer', credentialKeys: [], enabled: true }],
      };
    }
    if (path.endsWith('/integrations/definitions')) return { definitions: [] };
    if (path.endsWith('/integrations/bindings')) return { bindings: [] };
    if (path.endsWith('/integrations/credentials')) return { credentials: [] };
    if (path.endsWith('/integrations/repo-bindings')) return { repoBindings: [] };
    if (path.endsWith('/users/me/oauth-connections')) return { connections: [] };
  }
  if (path.endsWith(`/spaces/${SPACE}/plan`)) return net.plan ?? undefined;
  if (path.endsWith(`/spaces/${SPACE}`)) return { id: SPACE, directives: {} };
  return undefined;
}

const FAILED = Symbol('failed');

// A test that sets `surfaceGate` holds the active-surface read until it opens.
function response(path: string): Promise<unknown> {
  const gate = net.surfaceGate;
  if (gate && path.endsWith('/cybernetic/active-surface')) {
    return gate.then(() => answer(path));
  }
  return answer(path);
}

// Anything the page asks for that this file does not describe answers 404,
// which every read on the page already treats as "nothing there".
function answer(path: string): Promise<unknown> {
  const value = respond(path);
  if (value === FAILED) {
    return Promise.resolve({
      ok: false,
      status: 500,
      statusText: '',
      headers: { get: () => null },
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
  }
  const body = value === undefined ? '' : JSON.stringify(value);
  return Promise.resolve({
    ok: value !== undefined,
    status: value === undefined ? 404 : 200,
    statusText: '',
    headers: { get: () => null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  });
}

const space = {
  id: SPACE,
  name: 'Demo',
  slug: 'demo',
  memberCount: 1,
  myRole: 'admin' as const,
  defaultAgentId: null,
};

// Stable identities, as the real providers give: a fresh `headers` per render
// would refetch every read that depends on it.
const api = {
  apiUrl: '/api',
  spaceId: SPACE,
  headers: () => ({}),
  blockedSession: null,
  retrySession: () => undefined,
  authFetch: (input: string) => {
    net.reads.push(String(input));
    return response(String(input));
  },
};
const spaceContext = {
  spaces: [space],
  accessibleSpaces: [space],
  activeSpaceId: SPACE,
  activeSpace: space,
  setActiveSpaceId: () => undefined,
  isLoading: false,
  loadError: null,
  refresh: () => undefined,
};
const routeSpace = { ...space, slugFromRoute: 'demo' };

vi.mock('../components/providers.js', () => ({
  isSoloSpace: (s: { memberCount: number }) => s.memberCount <= 1,
  useApi: () => api,
  useSpace: () => spaceContext,
  useSpaceFromRoute: () => routeSpace,
}));

vi.mock('../lib/realtimeClient.js', () => {
  const client = {
    subscribe: (
      topic: { kind: string },
      listener: { onEvent?: (event: unknown, cursor: string) => void },
    ) => {
      net.topics.push(JSON.stringify(topic));
      const onEvent = listener.onEvent;
      if (onEvent) {
        net.listeners.set(topic.kind, [...(net.listeners.get(topic.kind) ?? []), onEvent]);
      }
      return {
        unsubscribe: () => {
          const rest = (net.listeners.get(topic.kind) ?? []).filter((l) => l !== onEvent);
          net.listeners.set(topic.kind, rest);
        },
        updatePresence: () => undefined,
      };
    },
    subscribeStatus: () => () => undefined,
    getStatus: () => ({ isConnected: true }),
  };
  return { getRealtimeClient: () => client, __resetRealtimeClientForTests: () => undefined };
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let renderPage: () => void;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = () => undefined;
  globalThis.fetch = ((input: string) => {
    net.reads.push(`raw ${String(input)}`);
    return response(String(input));
  }) as typeof fetch;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  window.localStorage.clear();
  net.reads = [];
  net.topics = [];
  net.replaced = [];
  net.pushed = [];
  net.sessions = [];
  net.failSessionList = false;
  net.agents = [HELMSMAN];
  net.runs = [];
  net.workflows = [];
  net.coach = null;
  net.actionItems = [];
  net.integrations = false;
  net.plan = null;
  net.surfaceGate = null;
  net.listeners = new Map();
  // The realtime brokers are module-level and refcounted, and a released topic
  // lingers for a teardown grace, so the next page would find it still held.
  resetActionCenterBroker();
  resetCoachSurfaceBroker();
  resetEntityEventsBroker();
  resetWorkbenchFolds();
  resetMediaBytesBroker();
  resetSessionEventsBroker();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renderPage = () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ThemeProvider, null, createElement(ChatPage)),
      ),
    );
  };
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});

// One act per turn: React flushes the effects a resolved read schedules only
// when an act scope closes, and those effects start the next reads. Each turn
// renders again so a URL the router replaced reaches the page.
async function settle() {
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      renderPage();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function land(search: string) {
  net.search = search;
  await settle();
}

const expandButton = () => container.querySelector('button[title="Expand Workbench"]');
const collapseButton = () => container.querySelector('button[title="Collapse Workbench"]');
const dockOpen = () => collapseButton() !== null && expandButton() === null;
const greetingReady = () => container.querySelector('.chat-orb-greeting.is-ready') !== null;
const lastUrl = () => net.replaced[net.replaced.length - 1] ?? null;
const distinct = (reads: readonly string[]) =>
  [...new Set(reads.filter((r) => r.startsWith('/api/') || r.startsWith('raw /api/')))].map((r) =>
    r.replace(/^raw /, '').replaceAll(SPACE, ':space').replaceAll(SESSION, ':session'),
  );

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    agentId: 'h',
    agentVersion: '1',
    status: 'PAUSED',
    createdAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    lastActivityAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    createdBy: USER,
    ...overrides,
  };
}

const FOLDED_SECTIONS = [
  'Plan',
  'Schedules',
  'Skills',
  'Applets',
  'Agents',
  'Integrations',
  'Coach review',
];

/** This browser has seen every folded section hold content in the space, so none sits behind More. */
function rememberEverySectionHeld() {
  window.localStorage.setItem(
    WORKBENCH_HELD_STORAGE_KEY,
    JSON.stringify([{ spaceId: SPACE, sections: FOLDED_SECTIONS }]),
  );
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await settle();
}

describe('the Workbench dock on landing (D3)', () => {
  it('opens on a new chat', async () => {
    await land('');
    expect(dockOpen()).toBe(true);
    expect(greetingReady()).toBe(true);
  });

  it('stays collapsed in a conversation the operator collapsed it in', async () => {
    net.sessions = [conversation()];
    window.localStorage.setItem(WORKBENCH_COLLAPSED_STORAGE_KEY, JSON.stringify([SESSION]));
    await land(`session=${SESSION}`);
    expect(dockOpen()).toBe(false);
    expect(expandButton()).not.toBeNull();
  });

  it('opens in a conversation with no remembered choice, and remembers a collapse', async () => {
    net.sessions = [conversation()];
    await land(`session=${SESSION}`);
    expect(dockOpen()).toBe(true);

    await click(collapseButton());
    expect(dockOpen()).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem(WORKBENCH_COLLAPSED_STORAGE_KEY) ?? '[]'),
    ).toEqual([SESSION]);

    await click(expandButton());
    expect(window.localStorage.getItem(WORKBENCH_COLLAPSED_STORAGE_KEY)).toBe('[]');
  });

  it('opens the Workbench on its Space tab when the bell is chosen on Chat', async () => {
    net.sessions = [conversation()];
    await land(`session=${SESSION}`);
    const tab = (label: string) =>
      [...container.querySelectorAll('[role="tab"]')].find((t) =>
        t.textContent?.startsWith(label),
      ) ?? null;
    await click(tab('Timeline'));
    await click(collapseButton());
    expect(dockOpen()).toBe(false);

    const bell = container.querySelector('button[aria-label^="Action Center"]');
    expect(bell).not.toBeNull();
    // The bell reads the address the browser holds, which this router does not write.
    window.history.replaceState(null, '', `/s/demo/chat?${net.search}`);
    net.replaced = [];
    await click(bell);
    expect(net.pushed).toEqual([]);
    expect(net.replaced[0]).toBe(`/s/demo/chat?session=${SESSION}&workbench=1`);
    expect(lastUrl()).toBe(`/s/demo/chat?session=${SESSION}`);
    expect(dockOpen()).toBe(true);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(
      /^Space/,
    );
    expect(window.localStorage.getItem(WORKBENCH_COLLAPSED_STORAGE_KEY)).toBe('[]');
  });

  it('leaves a folded conversation folded when StrictMode re-runs an arrival with the Workbench', async () => {
    net.sessions = [conversation()];
    window.localStorage.setItem(WORKBENCH_COLLAPSED_STORAGE_KEY, JSON.stringify([SESSION]));
    renderPage = () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            QueryClientProvider,
            { client },
            createElement(ThemeProvider, null, createElement(ChatPage)),
          ),
        ),
      );
    };
    await land(`session=${SESSION}&workbench=1`);
    expect(dockOpen()).toBe(true);
    expect(lastUrl()).toBe(`/s/demo/chat?session=${SESSION}`);
    expect(
      JSON.parse(window.localStorage.getItem(WORKBENCH_COLLAPSED_STORAGE_KEY) ?? '[]'),
    ).toEqual([SESSION]);
  });

  it('switches a phone to the Workbench when the bell is chosen on Chat', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    await land('');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    window.history.replaceState(null, '', `/s/demo/chat?${net.search}`);
    await click(document.querySelector('button[aria-label^="Action Center"]'));
    expect(net.pushed).toEqual([]);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(
      /^Space/,
    );
  });

  it('opens on a new chat in a space with no agent to answer', async () => {
    net.agents = [];
    await land('');
    expect(container.textContent).toContain('No assistant yet');
    expect(dockOpen()).toBe(true);
  });

  it('keeps the chat first on a phone', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    await land('');
    expect(container.textContent).toContain('This is Helmsman');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});

describe('what the open dock reads (D3 budget)', () => {
  beforeEach(rememberEverySectionHeld);

  it('reads six things a collapsed dock does not, and nothing per folded section', async () => {
    net.sessions = [conversation()];
    window.localStorage.setItem(WORKBENCH_COLLAPSED_STORAGE_KEY, JSON.stringify([SESSION]));
    await land(`session=${SESSION}`);
    const page = { reads: net.reads.length, topics: net.topics.length };

    await click(expandButton());
    expect(distinct(net.reads.slice(page.reads)).sort()).toEqual(
      [
        '/api/spaces/:space',
        '/api/spaces/:space/action-center?kind=session_invitation',
        '/api/sessions/presence?sessionIds=:session',
        '/api/spaces/:space/workflow-runs?status=running,paused&limit=50',
        '/api/spaces/:space/cascades/:session',
        '/api/spaces/:space/workflows?archived=true',
      ].sort(),
    );
    // Each of the six was read before this phase whenever the dock opened.
    // None is the Coach's state, which no folded header reads.
    // The page already holds the entity-events stream for a conversation.
    expect(net.topics.slice(page.topics)).toEqual([]);
  });

  it.each([
    ['a new chat', ''],
    ['a named conversation', `session=${SESSION}`],
  ])('reads nothing on a clock once open on %s', async (_, search) => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      shouldAdvanceTime: true,
    });
    try {
      net.sessions = [conversation()];
      net.workflows = [{ slug: 'weekly-roundup', name: 'Weekly roundup' }];
      net.runs = [
        {
          runId: 'r1',
          status: 'running',
          workflowSlug: 'weekly-roundup',
          startedAt: new Date().toISOString(),
        },
      ];
      await land(search);
      expect(dockOpen()).toBe(true);
      const reads = net.reads.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60_000);
      });
      await settle();
      // The composer's orchestrator health read is the page's one reviewed
      // timer (D3): a stopped orchestrator sends no event. The dock reads
      // nothing on a clock.
      const onClock = net.reads.slice(reads);
      expect(onClock.filter((r) => r !== '/api/health/orchestrator')).toEqual([]);
      expect(onClock.length).toBeLessThanOrEqual(240);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads Integrations only once the operator expands it', async () => {
    await land('');
    expect(dockOpen()).toBe(true);
    expect(net.reads.some((r) => r.includes('/integrations/'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/applets'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/anomalies'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/active-surface'))).toBe(false);

    const integrations = [...container.querySelectorAll('button[aria-expanded]')].find(
      (b) => b.textContent === 'Integrations',
    );
    await click(integrations ?? null);
    expect(net.reads).toContain('/api/integrations/definitions');
  });

  it('keeps an expanded section open across a switch to another inspector tab and back', async () => {
    await land('');
    const fold = (expanded: boolean) =>
      [...container.querySelectorAll(`button[aria-expanded="${String(expanded)}"]`)].find(
        (b) => b.textContent === 'Integrations',
      ) ?? null;
    const tab = (label: string) =>
      [...container.querySelectorAll('[role="tab"]')].find((t) =>
        t.textContent?.startsWith(label),
      ) ?? null;
    await click(fold(false));
    expect(fold(true)).not.toBeNull();

    await click(tab('Timeline'));
    expect(fold(true)).toBeNull();
    await click(tab('Space'));
    expect(fold(true)).not.toBeNull();
  });

  it('keeps an expanded section open after the page unmounts and the space comes back', async () => {
    await land('');
    const fold = (expanded: boolean) =>
      [...container.querySelectorAll(`button[aria-expanded="${String(expanded)}"]`)].find(
        (b) => b.textContent === 'Integrations',
      ) ?? null;
    await click(fold(false));
    expect(fold(true)).not.toBeNull();

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await land('');
    expect(fold(true)).not.toBeNull();
  });
});

describe('what a folded header carries (D3)', () => {
  beforeEach(rememberEverySectionHeld);

  const header = (title: string) =>
    [...container.querySelectorAll('button[aria-expanded="false"]')].find(
      (b) => b.textContent === title,
    )?.parentElement ?? null;

  function run(runId: string, status: string) {
    return {
      runId,
      status,
      workflowSlug: 'weekly-roundup',
      workflowRevision: 1,
      startedAt: new Date(Date.now() - HOUR).toISOString(),
      completedAt: null,
      durationMs: null,
      totalCostCents: null,
      totalTokens: null,
      evalScore: null,
      evalVerdict: null,
      taskCount: 1,
      pausedReason: null,
      initiatedByUserId: USER,
      sessionId: null,
      rootSessionId: null,
    };
  }

  function coach(lifecycle: string) {
    return {
      lifecycle,
      coachSessionId: COACH,
      pendingProposals: 0,
      pendingPlatformIssues: 0,
      pendingAnomalies: 0,
    };
  }

  let eventSeq = 0;
  async function entityEvent(eventType: string, payload: Record<string, unknown> = {}) {
    eventSeq += 1;
    const event = {
      eventId: `e-${String(eventSeq)}`,
      eventType,
      spaceId: SPACE,
      tenantId: 't',
      timestamp: Date.now(),
      causedBySessionId: COACH,
      payload,
      summary: eventType,
    };
    const listeners = net.listeners.get('space.entity_events') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of listeners) listener(event, `c-${String(eventSeq)}`);
      await Promise.resolve();
    });
    await settle();
  }

  it('badges the live skill runs on the folded Skills header', async () => {
    net.workflows = [{ slug: 'weekly-roundup', name: 'Weekly roundup' }];
    net.runs = [run('r1', 'running'), run('r2', 'running'), run('r3', 'paused')];
    await land('');
    expect(dockOpen()).toBe(true);
    const skills = header('Skills');
    expect(skills?.querySelector('[title="2 running"]')).not.toBeNull();
    expect(skills?.querySelector('[title="1 paused"]')).not.toBeNull();
  });

  it('badges on the folded Skills header only the runs the expanded list shows', async () => {
    net.workflows = [
      { slug: 'weekly-roundup', name: 'Weekly roundup' },
      { slug: 'old-digest', name: 'Old digest', purgedAt: new Date().toISOString() },
    ];
    net.runs = [
      run('r1', 'running'),
      { ...run('r2', 'running'), workflowSlug: 'old-digest' },
      { ...run('r3', 'paused'), workflowSlug: 'not-in-the-list' },
    ];
    await land('');
    const skills = header('Skills');
    expect(skills?.querySelector('[title="1 running"]')).not.toBeNull();
    expect(skills?.querySelector('[title$="paused"]')).toBeNull();

    const toggle = [...container.querySelectorAll('button[aria-expanded]')].find(
      (b) => b.textContent === 'Skills',
    );
    await click(toggle ?? null);
    expect(container.textContent).toContain('Weekly roundup');
    expect(container.textContent).not.toContain('Old digest');
  });

  it('leaves a platform workflow’s run off the folded Skills header, as the list does', async () => {
    net.workflows = [{ slug: 'weekly-roundup', name: 'Weekly roundup', system: true }];
    net.runs = [run('r1', 'running')];
    await land('');
    expect(net.reads).toContain(`/api/spaces/${SPACE}/workflows?archived=true`);
    expect(header('Skills')?.querySelector('[title$="running"]')).toBeNull();
  });

  it('shows no badge on the folded Skills header with no live run', async () => {
    await land('');
    expect(header('Skills')?.querySelector('[title$="running"], [title$="paused"]')).toBeNull();
  });

  function actionItem(id: string, kind: string, fields: Record<string, unknown>) {
    return {
      id,
      spaceId: SPACE,
      kind,
      title: id,
      summary: '',
      requestedAt: new Date(Date.now() - HOUR).toISOString(),
      requestedBy: { kind: 'agent', label: 'Helmsman' },
      priority: 'normal',
      relatesTo: [],
      allowedActions: ['dismiss'],
      audience: 'you',
      status: 'open',
      ...fields,
    };
  }

  const githubConsent = () =>
    actionItem('consent-github', 'needs_oauth_consent', {
      origin: {
        type: 'step',
        runId: 'run-1',
        stepExecutionId: 'step-1',
        sessionId: SESSION,
        pauseVersion: 1,
        operationId: 'api.github.call',
      },
      allowedActions: ['connect'],
      extension: {
        kind: 'oauth_consent',
        integrationKind: 'api',
        resourceKey: 'github',
        bindingId: 'binding-1',
        ownerScope: 'user',
        reason: 'never_connected',
      },
    });

  const toggle = (title: string, expanded: boolean) =>
    [...container.querySelectorAll(`button[aria-expanded="${String(expanded)}"]`)].find(
      (b) => b.textContent === title,
    ) ?? null;

  it('says on the folded Schedules header that an agent set one up, with no read', async () => {
    net.actionItems = [
      actionItem('armed-1', 'trigger_armed', {
        origin: { type: 'trigger_armed', scheduleId: 'sch-1', createdAt: new Date().toISOString() },
      }),
    ];
    await land('');
    expect(dockOpen()).toBe(true);
    expect(header('Schedules')?.textContent).toContain('1 set up by an agent lately');
    expect(net.reads.some((r) => r.includes('/schedules'))).toBe(false);
  });

  it('shows nothing on the folded Schedules header with no notice', async () => {
    await land('');
    expect(header('Schedules')?.textContent).not.toContain('set up by an agent');
  });

  it('counts the connection requests on the folded Integrations header, with no read', async () => {
    net.actionItems = [githubConsent()];
    await land('');
    expect(dockOpen()).toBe(true);
    expect(header('Integrations')?.textContent).toContain('1 needs setup');
    expect(net.reads.some((r) => r.includes('/integrations/'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/oauth-connections'))).toBe(false);
  });

  it('counts only the connection requests once Integrations folds again, with no read', async () => {
    net.integrations = true;
    net.actionItems = [githubConsent()];
    await land('');
    expect(header('Integrations')?.textContent).toContain('1 needs setup');

    await click(toggle('Integrations', false));
    expect(toggle('Integrations', true)?.parentElement?.textContent).toContain('2 need setup');

    await click(toggle('Integrations', true));
    const reads = net.reads.length;
    await settle();
    expect(header('Integrations')?.textContent).toContain('1 needs setup');
    expect(net.reads.slice(reads)).toEqual([]);
  });

  it('drops the count on the folded Integrations header when its connection request resolves', async () => {
    net.integrations = true;
    net.actionItems = [githubConsent()];
    await land('');
    await click(toggle('Integrations', false));
    await click(toggle('Integrations', true));
    expect(header('Integrations')?.textContent).toContain('1 needs setup');

    const reads = net.reads.length;
    const listeners = net.listeners.get('space.action_center') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of listeners) {
        listener({ kind: 'resolve', itemIds: ['consent-github'] }, 'ac-1');
      }
      await Promise.resolve();
    });
    await settle();
    expect(header('Integrations')?.textContent).not.toContain('setup');
    expect(net.reads.slice(reads).filter((r) => r.includes('/integrations/'))).toEqual([]);
  });

  it('shows a review the entity-events stream starts, with its session, and drops it when it ends', async () => {
    net.coach = coach('reviewing');
    await land('');
    expect(header('Coach review')?.textContent).not.toContain('Reviewing');

    await entityEvent('entity.coach.activated');
    const coachHeader = header('Coach review');
    expect(coachHeader?.textContent).toContain('Reviewing');
    expect(coachHeader?.querySelector('a')?.getAttribute('href')).toContain(COACH);

    await entityEvent('entity.coach.completed');
    expect(header('Coach review')?.textContent).not.toContain('Reviewing');
    expect(net.reads.some((r) => r.includes('/active-surface'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/anomalies'))).toBe(false);
  });

  it.each(['FAILED', 'CANCELLED', 'STALLED'])(
    'drops a review whose Coach session moves to %s, which sends no completion',
    async (status) => {
      await land('');
      await entityEvent('entity.coach.activated');
      await entityEvent('entity.session.status', { sessionId: COACH, status: 'RUNNING' });
      expect(header('Coach review')?.textContent).toContain('Reviewing');

      await entityEvent('entity.session.status', { sessionId: COACH, status });
      expect(header('Coach review')?.textContent).not.toContain('Reviewing');
      expect(header('Coach review')?.querySelector('a')).toBeNull();
      expect(net.reads.some((r) => r.includes('/active-surface'))).toBe(false);
    },
  );

  it('reads the Coach’s state only once the operator expands the section', async () => {
    net.coach = coach('stalled');
    await land('');
    const reads = net.reads.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    expect(net.reads.slice(reads)).toEqual([]);
    expect(header('Coach review')?.textContent).not.toContain('Stalled');

    const toggle = [...container.querySelectorAll('button[aria-expanded]')].find(
      (b) => b.textContent === 'Coach review',
    );
    await click(toggle ?? null);
    expect(net.reads).toContain(`/api/spaces/${SPACE}/cybernetic/active-surface`);
    expect(container.textContent).toContain('Stalled');
  });

  it('keeps the folded header’s Reviewing on expand until the active-surface read lands', async () => {
    net.coach = coach('stalled');
    let open = () => undefined as void;
    net.surfaceGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await land('');
    await entityEvent('entity.coach.activated');
    expect(header('Coach review')?.textContent).toContain('Reviewing');

    await click(toggle('Coach review', false));
    expect(net.reads).toContain(`/api/spaces/${SPACE}/cybernetic/active-surface`);
    expect(toggle('Coach review', true)).not.toBeNull();
    expect(container.textContent).toContain('Reviewing');
    expect(container.querySelector(`a[href*="${COACH}"]`)).not.toBeNull();
    expect(container.textContent).not.toContain('Idle');

    open();
    await settle();
    expect(container.textContent).toContain('Stalled');
    expect(container.textContent).not.toContain('Reviewing');
  });
});

describe('the More fold, the Plan section and the Skills count', () => {
  const PLAN_ROOT = '00000000-0000-4000-8000-000000000a01';
  const ASKING = '00000000-0000-4000-8000-000000000a02';
  const RUNNING = '00000000-0000-4000-8000-000000000a03';

  const toggle = (title: string, expanded?: boolean) =>
    [
      ...container.querySelectorAll(
        expanded === undefined
          ? 'button[aria-expanded]'
          : `button[aria-expanded="${String(expanded)}"]`,
      ),
    ].find((b) => b.textContent === title) ?? null;
  const moreFold = () => container.querySelector('[data-workbench-more]');
  const inMore = (title: string) => {
    const el = toggle(title);
    return el !== null && (moreFold()?.contains(el) ?? false);
  };

  function laneItem(nodeId: string, title: string, extra: Record<string, unknown> = {}) {
    return {
      nodeId,
      title,
      kind: 'step',
      status: 'active',
      revision: 1,
      updatedAt: new Date(Date.now() - HOUR).toISOString(),
      rootId: PLAN_ROOT,
      rootTitle: 'Plan 340 · Workbench',
      ...extra,
    };
  }

  function planAsk(nodeId: string) {
    return {
      id: `plan-ask:${nodeId}`,
      spaceId: SPACE,
      kind: 'approval',
      title: 'Pending approval · Ship it',
      summary: '',
      requestedAt: new Date(Date.now() - HOUR).toISOString(),
      requestedBy: { kind: 'agent', label: 'Helmsman' },
      priority: 'normal',
      relatesTo: [],
      allowedActions: ['dismiss'],
      audience: 'you',
      status: 'open',
      origin: { type: 'plan_ask', nodeId, revision: 1 },
    };
  }

  it('puts every section that has never held content behind one More fold', async () => {
    await land('');
    expect(dockOpen()).toBe(true);
    const more = [...container.querySelectorAll('button[aria-expanded]')].filter(
      (b) => b.textContent === 'More',
    );
    expect(more).toHaveLength(1);
    expect(moreFold()?.textContent).toContain('Applets');
    expect(moreFold()?.textContent).toContain('Coach review');
    expect(toggle('Applets')).toBeNull();

    await click(toggle('More', false));
    for (const title of FOLDED_SECTIONS) expect(inMore(title)).toBe(true);
    // Opening More mounts no section, so it reads nothing of theirs.
    expect(net.reads.some((r) => r.includes('/applets'))).toBe(false);
    expect(net.reads.some((r) => r.endsWith('/plan'))).toBe(false);
  });

  it('keeps a section whose folded header shows content in its place, with its count', async () => {
    net.workflows = [
      { slug: 'weekly-roundup', name: 'Weekly roundup' },
      { slug: 'digest', name: 'Digest' },
    ];
    await land('');
    const skills = toggle('Skills', false);
    expect(skills).not.toBeNull();
    expect(inMore('Skills')).toBe(false);
    expect(skills?.parentElement?.textContent).toContain('2 skills');
    expect(moreFold()?.textContent).not.toContain('Skills');
    expect(moreFold()?.textContent).toContain('Applets');
  });

  it('records a section that held content under More, and stands it in place on the next mount', async () => {
    net.integrations = true;
    await land('');
    await click(toggle('More', false));
    await click(toggle('Integrations', false));
    expect(container.textContent).toContain('Docs');
    // It does not move while the operator reads it.
    expect(inMore('Integrations')).toBe(true);
    expect(window.localStorage.getItem(WORKBENCH_HELD_STORAGE_KEY)).toContain('Integrations');

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await land('');
    expect(toggle('Integrations')).not.toBeNull();
    expect(inMore('Integrations')).toBe(false);
  });

  it('keeps a section open under More there when its header signal turns on, until the next mount', async () => {
    net.plan = {
      roots: [],
      lanes: {
        needsYou: { items: [], total: 0 },
        inFlight: { items: [], total: 0 },
        upNext: { items: [], total: 0 },
      },
    };
    await land('');
    await click(toggle('More', false));
    await click(toggle('Plan', false));
    expect(inMore('Plan')).toBe(true);

    const listeners = net.listeners.get('space.action_center') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of listeners) {
        listener({ kind: 'insert', items: [planAsk(ASKING)] }, 'ac-1');
      }
      await Promise.resolve();
    });
    await settle();
    expect(inMore('Plan')).toBe(true);
    expect(window.localStorage.getItem(WORKBENCH_HELD_STORAGE_KEY)).toContain('Plan');

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await land('');
    expect(inMore('Plan')).toBe(false);
  });

  it('returns a section opened and then closed under More to its place when its header signal turns on', async () => {
    net.plan = {
      roots: [],
      lanes: {
        needsYou: { items: [], total: 0 },
        inFlight: { items: [], total: 0 },
        upNext: { items: [], total: 0 },
      },
    };
    await land('');
    await click(toggle('More', false));
    await click(toggle('Plan', false));
    await click(toggle('Plan', true));
    expect(inMore('Plan')).toBe(true);

    const listeners = net.listeners.get('space.action_center') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of listeners) {
        listener({ kind: 'insert', items: [planAsk(ASKING)] }, 'ac-1');
      }
      await Promise.resolve();
    });
    await settle();
    expect(inMore('Plan')).toBe(false);
    const plan = toggle('Plan', false)?.parentElement ?? null;
    expect(plan?.querySelector('[title="1 pending"]')?.textContent).toBe('1');
  });

  it('shows no More fold once every section has held content', async () => {
    rememberEverySectionHeld();
    await land('');
    expect(moreFold()).toBeNull();
    expect(toggle('More')).toBeNull();
  });

  it('counts the pending plan steps on the folded Plan header and links the board, with no read', async () => {
    net.actionItems = [planAsk(ASKING)];
    await land('');
    const plan = toggle('Plan', false)?.parentElement ?? null;
    expect(inMore('Plan')).toBe(false);
    expect(plan?.querySelector('[title="1 pending"]')?.textContent).toBe('1');
    expect(plan?.querySelector('a')?.getAttribute('href')).toBe('/s/demo/plan');
    expect(net.reads.some((r) => r.endsWith('/plan'))).toBe(false);
  });

  it('lists the steps pending on the operator and those in flight, each linked to the plan page', async () => {
    net.actionItems = [planAsk(ASKING)];
    net.plan = {
      roots: [],
      lanes: {
        needsYou: { items: [laneItem(ASKING, 'Ship it', { reason: 'blocked' })], total: 1 },
        inFlight: { items: [laneItem(RUNNING, 'Build the fold')], total: 1 },
        upNext: { items: [laneItem(PLAN_ROOT, 'Queued step')], total: 1 },
      },
    };
    await land('');
    await click(toggle('Plan', false));
    expect(net.reads).toContain(`/api/spaces/${SPACE}/plan`);

    const step = (nodeId: string) =>
      container.querySelector(`[data-workbench-plan-step="${nodeId}"] a`);
    expect(step(ASKING)?.textContent).toBe('Ship it');
    expect(step(ASKING)?.getAttribute('href')).toBe(
      `/s/demo/plan?plan=${PLAN_ROOT}&node=${ASKING}`,
    );
    expect(step(RUNNING)?.textContent).toBe('Build the fold');
    expect(step(RUNNING)?.getAttribute('href')).toBe(
      `/s/demo/plan?plan=${PLAN_ROOT}&node=${RUNNING}`,
    );
    expect(container.textContent).not.toContain('Queued step');
  });
});

describe('where /chat lands (D4)', () => {
  it('returns a bare arrival to the reader’s conversation active within the window, by replace', async () => {
    net.sessions = [
      conversation({ lastActivityAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
    ];
    await land('');
    expect(lastUrl()).toBe(`/s/demo/chat?session=${SESSION}`);
    expect(net.pushed).toEqual([]);
    expect(greetingReady()).toBe(false);
  });

  it('lands on a new chat when the last activity is outside the window', async () => {
    net.sessions = [
      conversation({ lastActivityAt: new Date(Date.now() - 7 * HOUR).toISOString() }),
    ];
    await land('');
    expect(net.replaced.some((url) => url.includes('session='))).toBe(false);
    expect(greetingReady()).toBe(true);
  });

  it('lands on a new chat rather than resume another member’s conversation', async () => {
    net.sessions = [conversation({ createdBy: OTHER })];
    await land('');
    expect(net.replaced.some((url) => url.includes('session='))).toBe(false);
    expect(greetingReady()).toBe(true);
  });

  it('falls back to a new chat when the named conversation no longer exists', async () => {
    net.sessions = [conversation()];
    await land(`session=${GONE}`);
    expect(net.reads).toContain(`/api/sessions/${GONE}`);
    expect(lastUrl()).toBe('/s/demo/chat');
    // The URL named a conversation, so the landing does not then resume another.
    expect(net.replaced.some((url) => url.includes(SESSION))).toBe(false);
    expect(greetingReady()).toBe(true);
    expect(dockOpen()).toBe(true);
  });

  it('opens what a rehearsal link names, with its persona and baseline pin intact', async () => {
    net.sessions = [conversation()];
    await land('sim=sim-1&persona=persona-1&baseline=3');
    expect(net.replaced.some((url) => url.includes('session='))).toBe(false);
    const search = new URLSearchParams(net.search);
    expect(search.get('sim')).toBe('sim-1');
    expect(search.get('persona')).toBe('persona-1');
    expect(search.get('baseline')).toBe('3');
    expect(greetingReady()).toBe(true);
    expect(dockOpen()).toBe(true);
  });

  it('opens a new chat with the agent a link names, rather than resume', async () => {
    net.sessions = [conversation()];
    await land('agentId=h');
    expect(net.replaced.some((url) => url.includes('session='))).toBe(false);
    expect(greetingReady()).toBe(true);
  });

  it('lands on a usable new chat when the session list fails to read', async () => {
    net.failSessionList = true;
    await land('');
    expect(net.reads.some((r) => r.includes('/sessions?'))).toBe(true);
    expect(greetingReady()).toBe(true);
    expect(dockOpen()).toBe(true);
  });
});
