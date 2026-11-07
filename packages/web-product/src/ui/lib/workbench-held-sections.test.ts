import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_HELD_SPACES_LIMIT,
  WORKBENCH_HELD_STORAGE_KEY,
  placeWorkbenchSections,
  readHeldSections,
  rememberHeldSection,
  workbenchPlacement,
} from './workbench-held-sections.js';

function memoryStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & {
  value: () => string | null;
} {
  let stored: string | null = initial ?? null;
  return {
    getItem: (key) => (key === WORKBENCH_HELD_STORAGE_KEY ? stored : null),
    setItem: (key, value) => {
      if (key === WORKBENCH_HELD_STORAGE_KEY) stored = value;
    },
    value: () => stored,
  };
}

describe('the held-section record', () => {
  it('records a section once per space, and keeps spaces apart', () => {
    const storage = memoryStorage();
    rememberHeldSection(storage, 'a', 'Skills');
    rememberHeldSection(storage, 'a', 'Skills');
    rememberHeldSection(storage, 'a', 'Applets');
    rememberHeldSection(storage, 'b', 'Plan');
    expect(readHeldSections(storage, 'a')).toEqual(['Skills', 'Applets']);
    expect(readHeldSections(storage, 'b')).toEqual(['Plan']);
    expect(readHeldSections(storage, 'c')).toEqual([]);
  });

  it('drops the space seen longest ago past the limit', () => {
    const storage = memoryStorage();
    for (let i = 0; i <= WORKBENCH_HELD_SPACES_LIMIT; i++) {
      rememberHeldSection(storage, String(i), 'Skills');
    }
    expect(readHeldSections(storage, '0')).toEqual([]);
    expect(readHeldSections(storage, String(WORKBENCH_HELD_SPACES_LIMIT))).toEqual(['Skills']);
  });

  it('reads missing, malformed or refusing storage as nothing held', () => {
    expect(readHeldSections(null, 'a')).toEqual([]);
    expect(readHeldSections(memoryStorage('not json'), 'a')).toEqual([]);
    expect(readHeldSections(memoryStorage('{"a":["Skills"]}'), 'a')).toEqual([]);
    expect(
      readHeldSections(memoryStorage('[{"spaceId":"a","sections":["Skills",3]}, 7]'), 'a'),
    ).toEqual(['Skills']);
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readHeldSections(refusing, 'a')).toEqual([]);
    expect(() => {
      rememberHeldSection(refusing, 'a', 'Skills');
    }).not.toThrow();
  });
});

describe('workbenchPlacement', () => {
  const section = (title: string, holdsContent = false) => ({ title, holdsContent });

  it('keeps a section that holds content now, or held some before, in place and in order', () => {
    const { inPlace, more } = workbenchPlacement(
      [section('Plan'), section('Skills', true), section('Applets'), section('Coach review')],
      new Set(['Plan']),
      new Set(),
    );
    expect(inPlace.map((s) => s.title)).toEqual(['Plan', 'Skills']);
    expect(more.map((s) => s.title)).toEqual(['Applets', 'Coach review']);
  });

  it('keeps a section open under More there, whatever it holds or has held', () => {
    const { inPlace, more } = workbenchPlacement(
      [section('Plan', true), section('Skills', true), section('Applets')],
      new Set(['Plan', 'Applets']),
      new Set(['Plan', 'Applets']),
    );
    expect(inPlace.map((s) => s.title)).toEqual(['Skills']);
    expect(more.map((s) => s.title)).toEqual(['Plan', 'Applets']);
  });

  it('keeps a section under More while the operator has it open, whatever its signal', () => {
    const open = (title: string) => title === 'Plan';
    const first = placeWorkbenchSections([section('Plan')], new Set(), new Set(), open);
    expect(first.more.map((s) => s.title)).toEqual(['Plan']);
    expect([...first.keptUnderMore]).toEqual(['Plan']);

    const signalled = placeWorkbenchSections(
      [section('Plan', true)],
      new Set(['Plan']),
      first.keptUnderMore,
      open,
    );
    expect(signalled.inPlace).toEqual([]);
    expect(signalled.more.map((s) => s.title)).toEqual(['Plan']);
    expect(signalled.keptUnderMore).toBe(first.keptUnderMore);
  });

  it('returns a section opened and then closed under More to its place when its signal turns on', () => {
    const opened = placeWorkbenchSections(
      [section('Plan'), section('Applets')],
      new Set(),
      new Set(),
      (title) => title === 'Plan',
    );
    expect([...opened.keptUnderMore]).toEqual(['Plan']);

    const closed = placeWorkbenchSections(
      [section('Plan'), section('Applets')],
      new Set(),
      opened.keptUnderMore,
      () => false,
    );
    expect(closed.more.map((s) => s.title)).toEqual(['Plan', 'Applets']);
    expect([...closed.keptUnderMore]).toEqual([]);

    const signalled = placeWorkbenchSections(
      [section('Plan', true), section('Applets')],
      new Set(),
      closed.keptUnderMore,
      () => false,
    );
    expect(signalled.inPlace.map((s) => s.title)).toEqual(['Plan']);
    expect(signalled.more.map((s) => s.title)).toEqual(['Applets']);
  });

  it('never keeps a section open in its place under More', () => {
    const { inPlace, keptUnderMore } = placeWorkbenchSections(
      [section('Skills', true)],
      new Set(),
      new Set(),
      () => true,
    );
    expect(inPlace.map((s) => s.title)).toEqual(['Skills']);
    expect([...keptUnderMore]).toEqual([]);
  });

  it('puts nothing behind More once every section has held content', () => {
    const { more } = workbenchPlacement(
      [section('Skills'), section('Applets')],
      new Set(['Skills', 'Applets']),
      new Set(),
    );
    expect(more).toEqual([]);
  });
});
