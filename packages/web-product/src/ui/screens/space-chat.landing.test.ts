/**
 * @vitest-environment jsdom
 */
/**
 * The chat page's landing (Plan 338 D3, D4), rendered whole with only the
 * network, the realtime client and the router replaced: where the Workbench
 * dock lands, which conversation `/chat` lands on, and what the open dock
 * reads. Every HTTP read and realtime subscription the page makes is counted.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKBENCH_COLLAPSED_STORAGE_KEY } from '../lib/workbench-dock-memory.js';

const SPACE = '00000000-0000-4000-8000-000000000338';
const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000cc';
const SESSION = '00000000-0000-4000-8000-0000000000bb';
const GONE = '00000000-0000-4000-8000-0000000000dd';
const HOUR = 3_600_000;

const net = vi.hoisted(() => ({
  reads: [] as string[],
  topics: [] as string[],
  search: '',
  replaced: [] as string[],
  pushed: [] as string[],
  sessions: [] as Array<Record<string, unknown>>,
}));

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
  if (path.endsWith('/agents')) {
    return {
      agents: [
        { agentId: 'h', name: 'Helmsman', latestVersion: '1', systemRole: 'cybernetic-helmsman' },
      ],
    };
  }
  if (path.includes('/sessions?')) return { sessions: net.sessions };
  const direct = net.sessions.find((s) => path.endsWith(`/sessions/${String(s['sessionId'])}`));
  if (direct) return direct;
  if (path.includes('/action-center')) return { items: [] };
  if (path.endsWith(`/spaces/${SPACE}`)) return { id: SPACE, directives: {} };
  return undefined;
}

// Anything the page asks for that this file does not describe answers 404,
// which every read on the page already treats as "nothing there".
function response(path: string) {
  const value = respond(path);
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
    subscribe: (topic: unknown) => {
      net.topics.push(JSON.stringify(topic));
      return { unsubscribe: () => undefined, updatePresence: () => undefined };
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

beforeEach(async () => {
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
  // Fresh modules per test: the realtime brokers are module-level and
  // refcounted, so a second page in one registry would find its topics held.
  vi.resetModules();
  const { ChatPage } = await import('./space-chat.js');
  const { ThemeProvider } = await import('../providers/theme.js');
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

  it('keeps the chat first on a phone', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    await land('');
    expect(container.textContent).toContain('This is Helmsman');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});

describe('what the open dock reads (D3 budget)', () => {
  it('reads five things a collapsed dock does not, and nothing per folded section', async () => {
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
      ].sort(),
    );
    // The page already holds the entity-events stream for a conversation.
    expect(net.topics.slice(page.topics)).toEqual([]);
  });

  it('reads Integrations only once the operator expands it', async () => {
    await land('');
    expect(dockOpen()).toBe(true);
    expect(net.reads.some((r) => r.includes('/integrations/'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/workflows?archived=true'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/applets'))).toBe(false);
    expect(net.reads.some((r) => r.includes('/anomalies'))).toBe(false);

    const integrations = [...container.querySelectorAll('button[aria-expanded]')].find(
      (b) => b.textContent === 'Integrations',
    );
    await click(integrations ?? null);
    expect(net.reads).toContain('/api/integrations/definitions');
  });
});

describe('where /chat lands (D4)', () => {
  it('returns to the reader’s conversation active within the window, by replace', async () => {
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
});
