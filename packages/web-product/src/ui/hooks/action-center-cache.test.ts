/**
 * The Action Center cache's `whole` flag, through a bare QueryClient wired as
 * `useActionCenter` wires it. The snapshot sets the flag. Merges and removals
 * through `withItems` keep it. A REST refetch keeps it while the stream is up,
 * and drops it when the stream is down or the route has cut the read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { ACTION_CENTER_LIST_LIMIT } from '@aflow/schemas';
import type { ActionCenterItem } from './use-action-center-types.js';
import {
  itemsStructuralSharing,
  keepWhole,
  snapshotPayload,
  withItems,
  type ItemsPayload,
} from './action-center-cache.js';

const KEY = ['space', 's1', 'action-center'];

function item(id: string): ActionCenterItem {
  return {
    id,
    spaceId: '00000000-0000-0000-0000-000000000001',
    kind: 'coach_activity',
    origin: { type: 'coach_activity' },
    title: 't',
    summary: 's',
    requestedAt: '2026-05-24T10:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'agent' },
    priority: 'normal',
    relatesTo: [],
    allowedActions: [],
    audience: 'anyone',
    status: 'open',
  } as unknown as ActionCenterItem;
}

const itemsOf = (n: number, prefix = 'i'): ActionCenterItem[] =>
  Array.from({ length: n }, (_, i) => item(`${prefix}${String(i)}`));

describe('the whole flag in the Action Center cache', () => {
  let client: QueryClient;
  let observer: QueryObserver<ItemsPayload>;
  let unsubscribe: () => void;
  let connected: boolean;
  let restItems: ActionCenterItem[];

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    connected = true;
    restItems = itemsOf(3);
    observer = new QueryObserver<ItemsPayload>(client, {
      queryKey: KEY,
      queryFn: () => Promise.resolve({ items: restItems }),
      structuralSharing: itemsStructuralSharing(() => connected),
      enabled: false,
    });
    unsubscribe = observer.subscribe(() => undefined);
  });

  afterEach(() => {
    unsubscribe();
    client.clear();
  });

  const cached = (): ItemsPayload | undefined => client.getQueryData<ItemsPayload>(KEY);
  const edit = (fn: (prev: ItemsPayload | undefined) => ItemsPayload): void => {
    client.setQueryData<ItemsPayload>(KEY, fn);
  };

  it('leaves a REST read alone before any snapshot', async () => {
    await observer.refetch();
    expect(cached()?.whole).toBeUndefined();
    expect(cached()?.items).toHaveLength(3);
  });

  it('sets the flag on the snapshot and keeps it through merges and removals', () => {
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(itemsOf(ACTION_CENTER_LIST_LIMIT)));
    expect(cached()?.whole).toBe(true);

    edit((prev) => withItems(prev, [...(prev?.items ?? []), item('new')]));
    expect(cached()?.whole).toBe(true);
    expect(cached()?.items).toHaveLength(ACTION_CENTER_LIST_LIMIT + 1);

    edit((prev) =>
      withItems(
        prev,
        (prev?.items ?? []).filter((it) => it.id !== 'new'),
      ),
    );
    expect(cached()?.whole).toBe(true);
    expect(cached()?.items).toHaveLength(ACTION_CENTER_LIST_LIMIT);
  });

  it('keeps no flag through withItems on a REST list', async () => {
    await observer.refetch();
    edit((prev) => withItems(prev, [...(prev?.items ?? []), item('new')]));
    expect(cached()?.whole).toBeUndefined();
  });

  it('keeps the flag through a REST refetch while the stream is up', async () => {
    const all = itemsOf(ACTION_CENTER_LIST_LIMIT);
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(all));
    restItems = all;
    await observer.refetch();
    expect(cached()?.whole).toBe(true);
    expect(cached()?.items).toHaveLength(ACTION_CENTER_LIST_LIMIT);
  });

  it('keeps the flag where the refetch holds fewer items than the limit', async () => {
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(itemsOf(ACTION_CENTER_LIST_LIMIT + 5)));
    restItems = itemsOf(4);
    await observer.refetch();
    expect(cached()?.whole).toBe(true);
  });

  it('drops the flag on a REST refetch while the stream is down', async () => {
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(itemsOf(ACTION_CENTER_LIST_LIMIT)));
    connected = false;
    restItems = itemsOf(ACTION_CENTER_LIST_LIMIT);
    await observer.refetch();
    expect(cached()?.whole).toBeUndefined();
  });

  it('drops the flag where the route cut the refetch', async () => {
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(itemsOf(ACTION_CENTER_LIST_LIMIT + 50)));
    restItems = itemsOf(ACTION_CENTER_LIST_LIMIT);
    await observer.refetch();
    expect(cached()?.whole).toBeUndefined();
    expect(cached()?.items).toHaveLength(ACTION_CENTER_LIST_LIMIT);
  });

  it('sets the flag again on the next snapshot', async () => {
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(itemsOf(ACTION_CENTER_LIST_LIMIT)));
    connected = false;
    await observer.refetch();
    expect(cached()?.whole).toBeUndefined();
    connected = true;
    client.setQueryData<ItemsPayload>(KEY, snapshotPayload(itemsOf(ACTION_CENTER_LIST_LIMIT)));
    expect(cached()?.whole).toBe(true);
  });
});

describe('keepWhole', () => {
  it('returns a write that carries its own flag as it is', () => {
    const next = snapshotPayload(itemsOf(1));
    expect(keepWhole({ items: [] }, next, false)).toBe(next);
  });

  it('returns a write over a list that was not whole as it is', () => {
    const next = { items: itemsOf(2) };
    expect(keepWhole({ items: itemsOf(1) }, next, true)).toBe(next);
  });
});
