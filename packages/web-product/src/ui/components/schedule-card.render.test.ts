/**
 * @vitest-environment jsdom
 */
/**
 * One schedule card on two surfaces: the Triggers page shows each schedule in
 * full, and the Workbench folds each upcoming one to one line, whoever created
 * it. Both render the same component. The Workbench reads the server's upcoming
 * read, which picks its schedules, so this test only renders what it returns.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseActionCenterResult } from '../hooks/use-action-center.js';
import type { ScheduleRow } from './schedule-card.js';

const SPACE_ID = '00000000-0000-4000-8000-0000000000aa';
const MINUTE = 60_000;
const CREATING_SESSION = '00000000-0000-4000-8000-0000000000c1';
const ARMED_SESSION = '00000000-0000-4000-8000-0000000000c2';
const LAST_SESSION = '00000000-0000-4000-8000-0000000000c3';
const DAY = 24 * 60 * MINUTE;

const queried: { key: unknown; path: string }[] = [];
let schedules: ScheduleRow[] = [];
/** What the upcoming read counts, where it counts more than it lists. */
let upcomingTotal: number | undefined;

vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: (opts: { key: unknown; path: string }) => {
    queried.push({ key: opts.key, path: opts.path });
    if (opts.path === '/schedules/upcoming')
      return {
        data: { schedules, total: upcomingTotal ?? schedules.length },
        isLoading: false,
      };
    if (opts.path.startsWith('/schedules')) return { data: { schedules }, isLoading: false };
    return { data: { endpoints: [] }, isLoading: false };
  },
  useApiMutation: () => ({ mutateAsync: () => Promise.resolve() }),
}));

vi.mock('./providers.js', () => ({
  useSpace: () => ({ activeSpace: null }),
  useSpaceFromRoute: () => ({ id: SPACE_ID, slug: 'home' }),
}));

vi.mock('./schedule-card.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule-card.js')>();
  return { ...actual, ScheduleCard: vi.fn(actual.ScheduleCard) };
});

const { ScheduleCard } = await import('./schedule-card.js');
const { TriggersPage } = await import('../screens/space-triggers.js');
const { FoldedSchedulesNotice, WorkbenchSchedules } =
  await import('./workbench/WorkbenchSchedules.js');
const { WorkbenchLazySection } = await import('./workbench/WorkbenchSection.js');

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function schedule(id: string, overrides: Partial<ScheduleRow>): ScheduleRow {
  return {
    id,
    name: `Schedule ${id}`,
    description: null,
    kind: 'cron',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    scheduledAt: null,
    status: 'active',
    nextFireAt: at(4 * MINUTE),
    lastFiredAt: null,
    firingCount: 0,
    maxFirings: null,
    target: null,
    inputTemplate: {},
    lastError: null,
    targetRunId: null,
    lastRunId: null,
    createdByRunId: CREATING_SESSION,
    renewsScheduleId: null,
    expiresAt: null,
    createdAt: at(-1 * 60 * MINUTE),
    ...overrides,
  };
}

/** A one-shot an agent set up two days ago, which has run and is over. */
const firedOneShot = schedule('fired', {
  name: 'Send the release note',
  kind: 'one_shot',
  cronExpression: null,
  scheduledAt: at(-2 * DAY),
  status: 'expired',
  nextFireAt: null,
  lastFiredAt: at(-2 * DAY),
  firingCount: 1,
  createdAt: at(-3 * DAY),
});

/** A daily report an agent set up an hour ago, next due in four minutes. */
const upcoming = schedule('upcoming', { name: 'Daily report' });

const operatorMade = schedule('operator', { name: 'Weekly backup', createdByRunId: null });

const actionCenter = { lanes: { notices: [] } } as unknown as UseActionCenterResult;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no matchMedia, and the page's container asks it for the layout.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
  queried.length = 0;
  upcomingTotal = undefined;
  vi.mocked(ScheduleCard).mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(element: React.ReactElement): void {
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, element));
  });
}

function renderPage(): void {
  render(createElement(TriggersPage));
}

function renderWorkbench(state: UseActionCenterResult = actionCenter): void {
  render(
    createElement(WorkbenchSchedules, {
      state,
      spaceId: SPACE_ID,
      spaceSlug: 'home',
    }),
  );
}

/** The schedule cards, read as the accessibility tree reads them. */
function cards(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="article"]')];
}

function card(name: string): HTMLElement {
  const found = cards().find((el) => el.getAttribute('aria-label') === name);
  if (!found) throw new Error(`no schedule card named "${name}"`);
  return found;
}

/** The words of each element that holds text directly. */
function words(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('*')]
    .filter((child) => child.children.length === 0 && (child.textContent ?? '').length > 0)
    .map((child) => child.textContent ?? '');
}

function buttons(el: HTMLElement): string[] {
  return [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
}

describe('the Triggers page', () => {
  it('shows each schedule with its name, recurrence, timing and actions', () => {
    schedules = [upcoming, firedOneShot, operatorMade];
    renderPage();

    expect(container.textContent).toContain('On a schedule');
    const daily = words(card('Daily report'));
    expect(daily).toContain('Daily report');
    expect(daily).toContain('set up in chat');
    expect(daily).toContain('Every day at 09:00 UTC');
    expect(daily).toContain('in 4 min');
    expect(daily).toContain('never run');
    expect(buttons(card('Daily report'))).toEqual(['Pause', 'Delete']);

    const fired = words(card('Send the release note'));
    expect(fired).toContain('expired');
    expect(fired).toContain('—');
    expect(fired).toContain('ran 2 d ago');
    expect(buttons(card('Send the release note'))).toEqual(['Resume', 'Delete']);

    expect(words(card('Weekly backup'))).not.toContain('set up in chat');
  });
});

/** The expired rows a renewing shepherd leaves, one per renewal, newest first by index. */
function expiredRenewals(count: number): ScheduleRow[] {
  return Array.from({ length: count }, (_, i) =>
    schedule(`renewal-${String(i)}`, {
      name: `Shepherd renewal ${String(i)}`,
      cronExpression: '*/5 * * * *',
      status: 'expired',
      nextFireAt: null,
      firingCount: 50,
      lastFiredAt: at(-(i + 1) * 60 * MINUTE),
      createdAt: at(-(i + 6) * 60 * MINUTE),
    }),
  );
}

/** The expander under the schedule list, found by its words. */
function olderToggle(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => /older/.test(b.textContent ?? ''));
}

describe('the Triggers page with many expired rows', () => {
  it('shows every row that can still run and the five most recent expired ones', () => {
    const paused = schedule('paused', { name: 'Paused digest', status: 'paused' });
    const expired = expiredRenewals(49);
    schedules = [...[...expired].reverse(), paused, upcoming];
    renderPage();

    expect(cards().map((el) => el.getAttribute('aria-label'))).toEqual([
      'Daily report',
      'Paused digest',
      'Shepherd renewal 0',
      'Shepherd renewal 1',
      'Shepherd renewal 2',
      'Shepherd renewal 3',
      'Shepherd renewal 4',
    ]);
    const toggle = olderToggle();
    expect(toggle?.textContent).toBe('Show older (44)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals the rest under Show older, and folds them again', () => {
    schedules = [upcoming, ...expiredRenewals(49)];
    renderPage();

    act(() => {
      olderToggle()?.click();
    });
    expect(cards()).toHaveLength(50);
    expect(cards().at(-1)?.getAttribute('aria-label')).toBe('Shepherd renewal 48');
    expect(olderToggle()?.textContent).toBe('Hide older');
    expect(olderToggle()?.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      olderToggle()?.click();
    });
    expect(cards()).toHaveLength(6);
  });

  it('reads an active schedule past its end as expired', () => {
    const lapsed = expiredRenewals(5).map((row) => ({
      ...row,
      status: 'active',
      expiresAt: row.lastFiredAt,
    }));
    schedules = [upcoming, firedOneShot, ...lapsed];
    renderPage();

    expect(cards()).toHaveLength(6);
    expect(olderToggle()?.textContent).toBe('Show older (1)');
  });

  it('offers no expander with five expired rows or fewer', () => {
    schedules = [upcoming, ...expiredRenewals(5)];
    renderPage();

    expect(cards()).toHaveLength(6);
    expect(olderToggle()).toBeUndefined();
  });
});

describe('the folded Schedules header', () => {
  it('counts the trigger_armed notices alone, as set up by an agent', () => {
    const state = {
      lanes: {
        notices: [
          { id: 'trigger-armed:a', kind: 'trigger_armed' },
          { id: 'trigger-armed:b', kind: 'trigger_armed' },
          { id: 'other', kind: 'run_completed' },
        ],
      },
    } as unknown as UseActionCenterResult;
    render(createElement(FoldedSchedulesNotice, { state }));

    expect(container.textContent).toBe('2 set up by an agent lately');
  });
});

describe("the Workbench's Schedules section", () => {
  it('lists the schedules the upcoming read returns, in its order', () => {
    const later = schedule('later', { name: 'Weekly digest', createdAt: at(-2 * DAY) });
    schedules = [upcoming, later];
    renderWorkbench();

    expect(queried.map((q) => q.path)).toEqual(['/schedules/upcoming']);
    expect(container.textContent).toContain('Schedules');
    expect(container.textContent).not.toContain('Recently armed');
    expect(cards().map((el) => el.getAttribute('aria-label'))).toEqual([
      'Daily report',
      'Weekly digest',
    ]);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/s/home/triggers');
  });

  it('lists an operator-created schedule beside an agent-armed one', () => {
    schedules = [operatorMade, upcoming];
    renderWorkbench();

    expect(cards().map((el) => el.getAttribute('aria-label'))).toEqual([
      'Weekly backup',
      'Daily report',
    ]);
    expect(words(card('Weekly backup').querySelector('summary') as HTMLElement)).toEqual([
      'Weekly backup',
      'next in 4 min',
    ]);
  });

  it('says how many upcoming schedules the cap leaves out', () => {
    schedules = [upcoming, operatorMade];
    upcomingTotal = 9;
    renderWorkbench();

    expect(cards()).toHaveLength(2);
    expect(container.textContent).toContain('7 more upcoming on Triggers');
  });

  it('adds no count line when the list holds every upcoming schedule', () => {
    schedules = [upcoming, operatorMade];
    renderWorkbench();

    expect(container.textContent).not.toContain('more upcoming');
  });

  it('says no schedule is upcoming when opened under its fold with none', () => {
    schedules = [];
    render(
      createElement(WorkbenchLazySection, {
        title: 'Schedules',
        children: createElement(WorkbenchSchedules, {
          state: actionCenter,
          spaceId: SPACE_ID,
          spaceSlug: 'home',
        }),
      }),
    );
    act(() => {
      container.querySelector('button')?.click();
    });

    expect(container.textContent).toContain('No upcoming schedules');
  });

  it('reads the name and the next fire on one line, with the rest folded', () => {
    schedules = [upcoming];
    renderWorkbench();

    const daily = card('Daily report');
    const fold = daily.querySelector('details');
    expect(fold?.open).toBe(false);
    const line = fold?.querySelector('summary');
    expect(line?.children).toHaveLength(1);
    expect(words(line as HTMLElement)).toEqual(['Daily report', 'next in 4 min']);
    expect(buttons(daily)).toEqual([]);

    const folded = words(daily).slice(2);
    expect(folded).toEqual(['Every day at 09:00 UTC', 'never run']);
  });

  it('folds the runs of a schedule that will run again under its line', () => {
    schedules = [{ ...upcoming, firingCount: 3, lastFiredAt: at(-DAY) }];
    renderWorkbench();

    const daily = card('Daily report');
    expect(words(daily.querySelector('summary') as HTMLElement)).toEqual([
      'Daily report',
      'next in 4 min',
    ]);
    expect(words(daily)).toContain('ran 1 d ago · 3×');
  });

  it('opens the fold when the line is chosen', () => {
    schedules = [upcoming];
    renderWorkbench();

    const fold = card('Daily report').querySelector('details');
    act(() => {
      fold?.querySelector('summary')?.click();
    });
    expect(fold?.open).toBe(true);
  });

  it('never gives a time to a schedule that will not run', () => {
    schedules = [firedOneShot];
    renderWorkbench();

    const fired = card('Send the release note');
    expect(words(fired.querySelector('summary') as HTMLElement)).toEqual([
      'Send the release note',
      'expired',
    ]);
    expect(fired.textContent).not.toMatch(/next/);
  });

  it('shows a renewal the upcoming read returns as the live schedule it is', () => {
    const second = schedule('second', {
      name: 'Local PR Shepherd',
      firingCount: 2,
      maxFirings: 50,
      lastFiredAt: at(-5 * MINUTE),
      renewsScheduleId: 'first',
      createdAt: at(-2 * 60 * MINUTE),
    });
    schedules = [second];
    renderWorkbench();

    expect(words(card('Local PR Shepherd').querySelector('summary') as HTMLElement)).toEqual([
      'Local PR Shepherd',
      'next in 4 min',
    ]);
  });

  it('fetches the schedules again when a trigger_armed notice arrives', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    schedules = [upcoming];
    renderWorkbench();
    expect(invalidate).not.toHaveBeenCalled();

    const notice = { id: 'trigger-armed:upcoming', kind: 'trigger_armed' };
    renderWorkbench({ lanes: { notices: [notice] } } as unknown as UseActionCenterResult);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['space', SPACE_ID, 'schedules', 'upcoming'],
    });

    renderWorkbench({ lanes: { notices: [notice] } } as unknown as UseActionCenterResult);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no schedule is upcoming', () => {
    schedules = [];
    renderWorkbench();

    expect(container.textContent).toBe('');
  });
});

/** The links a card holds into a session, as href and label. */
function sessionLinks(el: HTMLElement): Array<{ href: string | null; label: string }> {
  return [...el.querySelectorAll('a')]
    .filter((a) => (a.getAttribute('href') ?? '').includes('/sessions/'))
    .map((a) => ({ href: a.getAttribute('href'), label: a.textContent ?? '' }));
}

const targeted = schedule('targeted', {
  name: 'Wake the shepherd',
  targetRunId: ARMED_SESSION,
  lastRunId: LAST_SESSION,
});
const lastOnly = schedule('last-only', {
  name: 'Daily report',
  lastRunId: LAST_SESSION,
  lastFiredAt: at(-DAY),
  firingCount: 1,
});
const neither = schedule('neither', { name: 'Weekly backup' });

describe('the session a schedule card links to', () => {
  for (const surface of ['page', 'workbench'] as const) {
    const show = surface === 'page' ? renderPage : () => renderWorkbench();

    it(`links a row with a target to the armed session, on the ${surface}`, () => {
      schedules = [targeted];
      show();

      expect(sessionLinks(card('Wake the shepherd'))).toEqual([
        { href: `/s/home/sessions/${ARMED_SESSION}`, label: 'Open the armed session ↗' },
      ]);
    });

    it(`links a row with only a last run to that run, on the ${surface}`, () => {
      schedules = [lastOnly];
      show();

      expect(sessionLinks(card('Daily report'))).toEqual([
        { href: `/s/home/sessions/${LAST_SESSION}`, label: 'Open the last run ↗' },
      ]);
    });

    it(`renders no session link for a row with neither, on the ${surface}`, () => {
      schedules = [neither];
      show();

      const backup = card('Weekly backup');
      expect(sessionLinks(backup)).toEqual([]);
      expect(backup.innerHTML).not.toContain(CREATING_SESSION);
    });
  }

  it('says a firing wakes the conversation being read, and links nowhere', () => {
    schedules = [targeted];
    render(
      createElement(WorkbenchSchedules, {
        state: actionCenter,
        spaceId: SPACE_ID,
        spaceSlug: 'home',
        currentSessionId: ARMED_SESSION,
      }),
    );

    const wake = card('Wake the shepherd');
    expect(sessionLinks(wake)).toEqual([]);
    expect(words(wake)).toContain('Wakes this conversation');
  });

  it('links the target from the conversation that created it, never that conversation', () => {
    schedules = [{ ...targeted }];
    render(
      createElement(WorkbenchSchedules, {
        state: actionCenter,
        spaceId: SPACE_ID,
        spaceSlug: 'home',
        currentSessionId: CREATING_SESSION,
      }),
    );

    expect(sessionLinks(card('Wake the shepherd'))).toEqual([
      { href: `/s/home/sessions/${ARMED_SESSION}`, label: 'Open the armed session ↗' },
    ]);
  });
});

describe('one schedule card on both surfaces', () => {
  it('renders the page and the Workbench through the same component, under one query key', () => {
    schedules = [upcoming];

    renderPage();
    const pageVariants = vi.mocked(ScheduleCard).mock.calls.map(([props]) => props.variant);
    const pageQuery = queried.find((q) => q.path.startsWith('/schedules'));
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    vi.mocked(ScheduleCard).mockClear();
    queried.length = 0;

    renderWorkbench();
    const workbenchVariants = vi.mocked(ScheduleCard).mock.calls.map(([props]) => props.variant);
    const workbenchQuery = queried.find((q) => q.path.startsWith('/schedules'));

    expect(pageVariants).toContain('page');
    expect(workbenchVariants).toContain('compact');
    // The Workbench's key sits under the page's, so a write that refreshes the
    // page refreshes the section too.
    expect(pageQuery?.key).toEqual(['space', SPACE_ID, 'schedules']);
    expect(workbenchQuery).toEqual({
      key: ['space', SPACE_ID, 'schedules', 'upcoming'],
      path: '/schedules/upcoming',
    });
  });
});
