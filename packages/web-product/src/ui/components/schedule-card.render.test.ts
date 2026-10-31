/**
 * @vitest-environment jsdom
 */
/**
 * One schedule card on two surfaces: the Triggers page shows each schedule in
 * full, and the Workbench shows the ones an agent set up in chat, trimmed to
 * its column. Both read the same query and render the same component.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseActionCenterResult } from '../hooks/use-action-center.js';
import type { ScheduleRow } from './schedule-card.js';

const SPACE_ID = '00000000-0000-4000-8000-0000000000aa';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const queried: { key: unknown; path: string }[] = [];
let schedules: ScheduleRow[] = [];

vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: (opts: { key: unknown; path: string }) => {
    queried.push({ key: opts.key, path: opts.path });
    if (opts.path.startsWith('/schedules')) return { data: { schedules }, isLoading: false };
    return { data: { endpoints: [] }, isLoading: false };
  },
  useApiMutation: () => ({ mutateAsync: () => Promise.resolve() }),
}));

vi.mock('./providers.js', () => ({
  useSpaceFromRoute: () => ({ id: SPACE_ID, slug: 'home' }),
}));

vi.mock('./schedule-card.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule-card.js')>();
  return { ...actual, ScheduleCard: vi.fn(actual.ScheduleCard) };
});

const { ScheduleCard } = await import('./schedule-card.js');
const { TriggersPage } = await import('../screens/space-triggers.js');
const { WorkbenchSchedules } = await import('./workbench/WorkbenchSchedules.js');

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
    createdByRunId: '00000000-0000-4000-8000-0000000000c1',
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

const renewal = schedule('renewal', {
  name: 'Shepherd, renewed',
  renewsScheduleId: '00000000-0000-4000-8000-0000000000d1',
});
const operatorMade = schedule('operator', { name: 'Weekly backup', createdByRunId: null });
const longAgo = schedule('old', { name: 'Old reminder', createdAt: at(-10 * DAY) });

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

describe("the Workbench's Schedules section", () => {
  it('lists only schedules an agent set up in chat lately, newest first', () => {
    schedules = [firedOneShot, renewal, operatorMade, longAgo, upcoming];
    renderWorkbench();

    expect(container.textContent).toContain('Schedules');
    expect(container.textContent).not.toContain('Recently armed');
    expect(cards().map((el) => el.getAttribute('aria-label'))).toEqual([
      'Daily report',
      'Send the release note',
    ]);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/s/home/triggers');
  });

  it("reads a schedule's name, state badge and time line", () => {
    schedules = [upcoming];
    renderWorkbench();

    const daily = card('Daily report');
    expect(words(daily)).toEqual(['Daily report', 'active', 'next in 4 min']);
    expect(buttons(daily)).toEqual([]);
  });

  it('reads an expired one-shot that fired as expired and ran once, never as will run', () => {
    schedules = [firedOneShot];
    renderWorkbench();

    const fired = card('Send the release note');
    expect(words(fired)).toEqual(['Send the release note', 'expired', 'ran once · 2 d ago']);
    expect(fired.textContent).not.toMatch(/will run|next/);
  });

  it('reads a one-shot whose end has passed as expired while its status still says active', () => {
    schedules = [{ ...firedOneShot, status: 'active', expiresAt: at(-MINUTE) }];
    renderWorkbench();

    expect(words(card('Send the release note'))).toEqual([
      'Send the release note',
      'expired',
      'ran once · 2 d ago',
    ]);
  });

  it('counts the runs of a schedule that will run again', () => {
    schedules = [{ ...upcoming, firingCount: 3, lastFiredAt: at(-DAY) }];
    renderWorkbench();

    expect(words(card('Daily report'))).toContain('next in 4 min · ran 3×');
  });

  it('shows the renewal that now carries a schedule, never the expired one it renewed', () => {
    const original = schedule('original', {
      name: 'Local PR Shepherd',
      status: 'expired',
      nextFireAt: null,
      lastFiredAt: at(-DAY),
      firingCount: 50,
      maxFirings: 50,
      createdAt: at(-2 * DAY),
    });
    const first = schedule('first', {
      name: 'Local PR Shepherd',
      status: 'expired',
      nextFireAt: null,
      firingCount: 50,
      maxFirings: 50,
      renewsScheduleId: 'original',
      createdAt: at(-DAY),
    });
    const second = schedule('second', {
      name: 'Local PR Shepherd',
      firingCount: 2,
      maxFirings: 50,
      lastFiredAt: at(-5 * MINUTE),
      renewsScheduleId: 'first',
      createdAt: at(-2 * 60 * MINUTE),
    });
    schedules = [second, upcoming, first, original];
    renderWorkbench();

    expect(cards().map((el) => el.getAttribute('aria-label'))).toEqual([
      'Daily report',
      'Local PR Shepherd',
    ]);
    expect(words(card('Local PR Shepherd'))).toEqual([
      'Local PR Shepherd',
      'active',
      'next in 4 min · ran 2×',
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['space', SPACE_ID, 'schedules'] });

    renderWorkbench({ lanes: { notices: [notice] } } as unknown as UseActionCenterResult);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no agent has set one up', () => {
    schedules = [operatorMade, renewal, longAgo];
    renderWorkbench();

    expect(container.textContent).toBe('');
  });
});

describe('one schedule card on both surfaces', () => {
  it('renders the page and the Workbench through the same component and query', () => {
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
    expect(workbenchQuery).toEqual(pageQuery);
    expect(pageQuery?.key).toEqual(['space', SPACE_ID, 'schedules']);
  });
});
