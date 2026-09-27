import { describe, it, expect } from 'vitest';
import { MemoryPutInputSchema, MemoryPutOutputSchema, MemoryPatchOutputSchema } from '../memory.js';

describe('memory write surface schemas (Plan 249 P2)', () => {
  it('drops a caller-supplied provenance — provenance is server-derived', () => {
    const parsed = MemoryPutInputSchema.parse({
      path: '/notes/x.md',
      docType: 'markdown',
      content: { inlineText: 'hello' },
      // A caller trying to forge provenance must not be able to.
      provenance: { actor: 'user', runId: '11111111-1111-1111-1111-111111111111' },
    });
    expect('provenance' in (parsed as Record<string, unknown>)).toBe(false);
  });

  it('put output accepts the links / properties / incomingLinkCount block', () => {
    const out = MemoryPutOutputSchema.parse({
      id: '00000000-0000-0000-0000-0000000000aa',
      path: '/notes/x.md',
      version: 1,
      contentHash: 'h',
      sizeBytes: 5,
      embeddingStatus: 'pending',
      links: { resolved: 1, ghostCount: 2, ghosts: ['/ghost.md', '/g2.md'], clamped: false },
      properties: {
        derived: { status: 'active' },
        diagnosticCount: 1,
        diagnostics: [{ key: 'bad', reason: 'unsupported_value', message: 'nope' }],
      },
      incomingLinkCount: 3,
    });
    expect(out.links?.ghostCount).toBe(2);
    expect(out.properties?.derived).toEqual({ status: 'active' });
    expect(out.incomingLinkCount).toBe(3);
  });

  it('put output stays valid without the new blocks (structural/json writes)', () => {
    const out = MemoryPutOutputSchema.parse({
      id: '00000000-0000-0000-0000-0000000000aa',
      path: '/data/config.json',
      version: 1,
      contentHash: 'h',
      sizeBytes: 5,
      embeddingStatus: 'disabled',
    });
    expect(out.links).toBeUndefined();
    expect(out.properties).toBeUndefined();
    expect(out.incomingLinkCount).toBeUndefined();
  });

  it('patch output accepts links / properties but has no incomingLinkCount field', () => {
    const out = MemoryPatchOutputSchema.parse({
      id: '00000000-0000-0000-0000-0000000000aa',
      path: '/notes/x.md',
      version: 2,
      contentHash: 'h',
      sizeBytes: 5,
      embeddingStatus: 'pending',
      links: { resolved: 0, ghostCount: 1, ghosts: ['/ghost.md'] },
    });
    expect(out.links?.ghostCount).toBe(1);
    expect('incomingLinkCount' in (out as Record<string, unknown>)).toBe(false);
  });

  it('caps the ghost sample at 10 and the diagnostics sample at 10', () => {
    const elevenGhosts = Array.from({ length: 11 }, (_, i) => `/g${String(i)}.md`);
    expect(() =>
      MemoryPutOutputSchema.parse({
        id: '00000000-0000-0000-0000-0000000000aa',
        path: '/notes/x.md',
        version: 1,
        contentHash: 'h',
        sizeBytes: 5,
        embeddingStatus: 'pending',
        links: { resolved: 0, ghostCount: 11, ghosts: elevenGhosts },
      }),
    ).toThrow();
  });
});
