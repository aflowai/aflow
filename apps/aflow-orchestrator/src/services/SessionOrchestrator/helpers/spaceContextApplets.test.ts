import { describe, it, expect } from 'vitest';
import {
  deriveInstalledAppletEntries,
  SPACE_CONTEXT_LIMITS,
  SpaceContextAppletsSectionSchema,
  type InstalledAppletDefinitionRow,
  type InstalledAppletSummary,
} from '@aflow/schemas';
import { APPLETS_GUIDANCE, composeAppletsSection } from './spaceContextApplets.js';

function definitionRow(
  overrides?: Partial<InstalledAppletDefinitionRow>,
): InstalledAppletDefinitionRow {
  return {
    artifactId: '550e8400-e29b-41d4-a716-446655440000',
    headName: 'Chess Head',
    appletKey: 'chess',
    name: 'Chess',
    description: 'Two-player chess',
    semanticDescription: 'A two-player chess board. Players alternate moves by agreement.',
    liveInstances: 2,
    ...overrides,
  };
}

function entry(i: number, liveInstances = 0): InstalledAppletSummary {
  return {
    artifactId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    appletKey: `applet-${String(i)}`,
    name: `Applet ${String(i)}`,
    liveInstances,
  };
}

describe('deriveInstalledAppletEntries', () => {
  it('projects artifactId, appletKey, name, first sentence of semanticDescription, and the live count', () => {
    const entries = deriveInstalledAppletEntries([definitionRow()]);
    expect(entries).toEqual([
      {
        artifactId: '550e8400-e29b-41d4-a716-446655440000',
        appletKey: 'chess',
        name: 'Chess',
        description: 'A two-player chess board.',
        liveInstances: 2,
      },
    ]);
  });

  it('never surfaces a row without an appletKey — it cannot be instantiated', () => {
    expect(deriveInstalledAppletEntries([definitionRow({ appletKey: null })])).toEqual([]);
    expect(deriveInstalledAppletEntries([definitionRow({ appletKey: '' })])).toEqual([]);
  });

  it('falls back to the artifact head name and the plain description', () => {
    const entries = deriveInstalledAppletEntries([
      definitionRow({ name: null, semanticDescription: null }),
    ]);
    expect(entries).toEqual([
      {
        artifactId: '550e8400-e29b-41d4-a716-446655440000',
        appletKey: 'chess',
        name: 'Chess Head',
        description: 'Two-player chess',
        liveInstances: 2,
      },
    ]);
  });

  it('omits description entirely when the row carries neither field', () => {
    const entries = deriveInstalledAppletEntries([
      definitionRow({ description: null, semanticDescription: null }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('description');
  });
});

describe('composeAppletsSection', () => {
  it('returns undefined when nothing is installed — no empty section in the context', () => {
    expect(composeAppletsSection([])).toBeUndefined();
  });

  it('passes entries and counts through, schema-valid, with the mechanism-carrying guidance', () => {
    const section = composeAppletsSection([entry(1, 3), entry(2)]);
    expect(section).toBeDefined();
    expect(SpaceContextAppletsSectionSchema.parse(section)).toEqual(section);
    expect(section!.installed).toHaveLength(2);
    expect(section!.installed[0]!.liveInstances).toBe(3);
    expect(section!.total).toBe(2);
    expect(section!.truncated).toBeUndefined();
    expect(section!.guidance).toContain('ui.applet.instantiate {artifactId}');
    expect(section!.guidance).toContain('live instances and their actions surface automatically');
    expect(section!.guidance).toContain('These are all applets installed in this space.');
  });

  it('caps installed at SPACE_CONTEXT_LIMITS.applets with truncation + overflow guidance', () => {
    expect(SPACE_CONTEXT_LIMITS.applets).toBe(10);
    const entries = Array.from({ length: 12 }, (_, i) => entry(i));
    const section = composeAppletsSection(entries);
    expect(section!.installed).toHaveLength(10);
    expect(section!.total).toBe(12);
    expect(section!.truncated).toBe(true);
    expect(section!.guidance).toContain('2 more installed applets not shown');
    expect(section!.guidance).toContain('ui.artifact.list');
    expect(section!.guidance).toContain(APPLETS_GUIDANCE);
  });
});
