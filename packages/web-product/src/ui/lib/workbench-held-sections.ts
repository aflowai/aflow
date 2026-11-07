/**
 * Which Workbench sections have held content in a space, as this browser has
 * seen them. The Workbench puts every section that never has behind one More
 * fold at the bottom of the pane, so an empty Applets or an idle Coach review
 * does not cost the height of a full one. A section that has held content
 * keeps its place after it empties, so the board does not reshuffle as work
 * comes and goes.
 *
 * The record lives in storage, because the folded sections read nothing until
 * the operator expands them. Without it, a reload would put every section
 * that carries no header signal back under More.
 */

export const WORKBENCH_HELD_STORAGE_KEY = 'aflow.workbench.heldSections';

/** How many spaces a browser remembers. The space seen longest ago is dropped first. */
export const WORKBENCH_HELD_SPACES_LIMIT = 100;

interface HeldEntry {
  spaceId: string;
  sections: string[];
}

function readEntries(storage: Pick<Storage, 'getItem'> | null): HeldEntry[] {
  try {
    const raw = storage?.getItem(WORKBENCH_HELD_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown): HeldEntry[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { spaceId, sections } = entry as { spaceId?: unknown; sections?: unknown };
      if (typeof spaceId !== 'string' || !Array.isArray(sections)) return [];
      return [{ spaceId, sections: sections.filter((s): s is string => typeof s === 'string') }];
    });
  } catch {
    return [];
  }
}

/** The sections that have held content in this space. Storage that is missing, full or refusing reads as none. */
export function readHeldSections(
  storage: Pick<Storage, 'getItem'> | null,
  spaceId: string,
): string[] {
  return readEntries(storage).find((entry) => entry.spaceId === spaceId)?.sections ?? [];
}

/** Records that a section has held content in this space, and moves the space to the front. */
export function rememberHeldSection(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  spaceId: string,
  section: string,
): void {
  const entries = readEntries(storage);
  const current = entries.find((entry) => entry.spaceId === spaceId)?.sections ?? [];
  if (current.includes(section) && entries[0]?.spaceId === spaceId) return;
  const next: HeldEntry[] = [
    { spaceId, sections: current.includes(section) ? current : [...current, section] },
    ...entries.filter((entry) => entry.spaceId !== spaceId),
  ].slice(0, WORKBENCH_HELD_SPACES_LIMIT);
  try {
    storage?.setItem(WORKBENCH_HELD_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A refused write costs only the memory: the section stays under More.
  }
}

/**
 * The sections in their place, and those behind More, each in the order
 * given. A section stands in its place where it holds something now or has
 * held something before.
 */
export function workbenchPlacement<T extends { title: string; holdsContent: boolean }>(
  sections: readonly T[],
  held: ReadonlySet<string>,
): { inPlace: T[]; more: T[] } {
  const inPlace: T[] = [];
  const more: T[] = [];
  for (const section of sections) {
    (section.holdsContent || held.has(section.title) ? inPlace : more).push(section);
  }
  return { inPlace, more };
}
