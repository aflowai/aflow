import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_HELD_SPACES_LIMIT,
  WORKBENCH_HELD_STORAGE_KEY,
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

  it('puts nothing behind More once every section has held content', () => {
    const { more } = workbenchPlacement(
      [section('Skills'), section('Applets')],
      new Set(['Skills', 'Applets']),
      new Set(),
    );
    expect(more).toEqual([]);
  });
});
