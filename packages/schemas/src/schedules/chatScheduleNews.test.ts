import { describe, expect, it } from 'vitest';
import {
  CHAT_SCHEDULE_LIST_LIMIT,
  CHAT_SCHEDULE_NEWS_WINDOW_MS,
  selectChatScheduleNews,
  type ChatScheduleFacts,
} from './chatScheduleNews.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 60 * 60 * 1000;

interface Row extends ChatScheduleFacts {
  id: string;
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    armedInChat: true,
    renewsScheduleId: null,
    status: 'active',
    createdAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  };
}

function ids(rows: readonly Row[]): string[] {
  return selectChatScheduleNews(rows, (r) => r, NOW).map((r) => r.id);
}

describe('the schedules set up in chat that are news', () => {
  it('keeps one an agent set up in chat within the window, expired or not', () => {
    expect(ids([row('armed'), row('fired', { status: 'expired' })])).toEqual(['armed', 'fired']);
  });

  it('drops a renewal, one the operator made, a deleted one and one past the window', () => {
    const old = new Date(NOW - CHAT_SCHEDULE_NEWS_WINDOW_MS - 1).toISOString();
    expect(
      ids([
        row('renewal', { renewsScheduleId: 'armed' }),
        row('operator', { armedInChat: false }),
        row('deleted', { status: 'deleted' }),
        row('old', { createdAt: old }),
      ]),
    ).toEqual([]);
  });

  it('lists the newest first, up to the limit, whether createdAt is a Date or a string', () => {
    const rows = Array.from({ length: CHAT_SCHEDULE_LIST_LIMIT + 2 }, (_, i) =>
      row(String(i), {
        createdAt: i % 2 === 0 ? new Date(NOW - i * HOUR) : new Date(NOW - i * HOUR).toISOString(),
      }),
    );
    const picked = ids([...rows].reverse());
    expect(picked).toHaveLength(CHAT_SCHEDULE_LIST_LIMIT);
    expect(picked.slice(0, 3)).toEqual(['0', '1', '2']);
  });
});
