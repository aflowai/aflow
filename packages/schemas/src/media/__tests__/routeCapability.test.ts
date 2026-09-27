import { describe, expect, it } from 'vitest';
import {
  IMAGE_REFERENCE_ROLES,
  IMAGE_ROUTE_KEYS,
  MAX_IMAGE_REFERENCES_PER_ROLE,
  maxReferencesPerRole,
  MEDIA_ROUTE_CAPABILITIES,
  MediaRouteCapabilitySchema,
  checkMediaRouteConditioning,
  mediaRouteCapability,
  mediaRouteConditioningModes,
  mediaRoutesAccepting,
  VIDEO_ROUTE_KEYS,
  type ImageReferenceRole,
} from '../routeCapability.js';

function route(key: string) {
  const found = mediaRouteCapability(key);
  if (found === undefined) throw new Error(`no descriptor for '${key}'`);
  return found;
}

function references(role: ImageReferenceRole, count: number) {
  return Array.from({ length: count }, () => ({ role }));
}

describe('media route capability descriptors', () => {
  it('offers exactly the routes it declares, split by medium', () => {
    const declared = MEDIA_ROUTE_CAPABILITIES.map((entry) => entry.routeKey).sort();
    const selectable = [...IMAGE_ROUTE_KEYS, ...VIDEO_ROUTE_KEYS].sort();
    expect(selectable).toEqual(declared);
  });

  it('sorts each key under its own medium', () => {
    for (const key of IMAGE_ROUTE_KEYS) expect(route(key).medium).toBe('image');
    for (const key of VIDEO_ROUTE_KEYS) expect(route(key).medium).toBe('video');
  });

  it('parses as its own schema', () => {
    for (const entry of MEDIA_ROUTE_CAPABILITIES) {
      expect(() => MediaRouteCapabilitySchema.parse(entry)).not.toThrow();
    }
  });

  it('derives the conditioning modes rather than declaring them', () => {
    expect(mediaRouteConditioningModes(route('gpt-image'))).toEqual(['prompt']);
    expect(mediaRouteConditioningModes(route('google-pro-image'))).toEqual(['prompt', 'reference']);
    expect(mediaRouteConditioningModes(route('google-veo'))).toEqual(['prompt', 'frames']);
  });

  it('derives each medium’s ceiling from the most capable route of that medium', () => {
    for (const medium of ['image', 'video'] as const) {
      for (const role of IMAGE_REFERENCE_ROLES) {
        const highest = Math.max(
          0,
          ...MEDIA_ROUTE_CAPABILITIES.filter((entry) => entry.medium === medium).map(
            (entry) => entry.references[role] ?? 0,
          ),
        );
        expect(maxReferencesPerRole(medium)[role]).toBe(highest);
      }
    }
  });

  it('keeps one medium’s ceiling off the other', () => {
    // A video route reading twelve character references must not be what an
    // image operation validates against — the schema would stop teaching the
    // number any image model actually reads.
    const video = maxReferencesPerRole('video');
    expect(MAX_IMAGE_REFERENCES_PER_ROLE.character).toBeLessThan(video.character);
  });
});

describe('references a route reads as named entities', () => {
  const named = (label: string, count: number) =>
    Array.from({ length: count }, () => ({ role: 'character' as const, label }));

  it('accepts entities within the route’s bounds when a frame starts the clip', () => {
    expect(
      checkMediaRouteConditioning({
        route: route('runware-kling'),
        conditioning: {
          mode: 'reference',
          references: [...named('Mara', 4), ...named('Iven', 1)],
          hasFirstFrame: true,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses entities on a render that starts from the prompt alone', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('runware-kling'),
      conditioning: { mode: 'reference', references: named('Mara', 1), hasFirstFrame: false },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('first frame');
  });

  it('refuses more identities than the route carries, naming them', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('runware-kling'),
      conditioning: {
        mode: 'reference',
        references: [...named('A', 1), ...named('B', 1), ...named('C', 1), ...named('D', 1)],
        hasFirstFrame: true,
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("'D'");
  });

  it('refuses more images of one identity than the route reads', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('runware-kling'),
      conditioning: { mode: 'reference', references: named('Mara', 5), hasFirstFrame: true },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("'Mara'");
  });

  it('refuses an unlabelled reference, which the prompt could never name', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('runware-kling'),
      conditioning: {
        mode: 'reference',
        references: [{ role: 'character' }],
        hasFirstFrame: true,
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('label');
  });
});

describe('checkMediaRouteConditioning', () => {
  it('accepts prompt-only conditioning on every route', () => {
    for (const entry of MEDIA_ROUTE_CAPABILITIES) {
      expect(
        checkMediaRouteConditioning({ route: entry, conditioning: { mode: 'prompt' } }),
      ).toEqual({ ok: true });
    }
  });

  it('refuses a last frame on the route that drops it, naming the ones that interpolate', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('sora'),
      conditioning: { mode: 'frames', lastFrame: true },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('google-veo');
    expect(
      checkMediaRouteConditioning({
        route: route('sora'),
        conditioning: { mode: 'frames', lastFrame: false },
      }),
    ).toEqual({ ok: true });
    expect(
      checkMediaRouteConditioning({
        route: route('google-veo'),
        conditioning: { mode: 'frames', lastFrame: true },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses frame conditioning on a route that takes no source frame', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('google-pro-image'),
      conditioning: { mode: 'frames', lastFrame: false },
    });
    expect(verdict.ok).toBe(false);
  });

  it('refuses reference packs on a route that reads none', () => {
    const verdict = checkMediaRouteConditioning({
      route: route('gpt-image'),
      conditioning: { mode: 'reference', references: references('character', 1) },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('google-pro-image');
  });

  it('refuses more references of a role than the route reads, and accepts the limit', () => {
    const capable = route('google-pro-image');
    const limit = capable.references['character'] ?? 0;
    expect(
      checkMediaRouteConditioning({
        route: capable,
        conditioning: { mode: 'reference', references: references('character', limit) },
      }),
    ).toEqual({ ok: true });
    const verdict = checkMediaRouteConditioning({
      route: capable,
      conditioning: { mode: 'reference', references: references('character', limit + 1) },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(String(limit));
  });

  it('refuses provider-native continuation everywhere, because no wired route returns a handle', () => {
    expect(mediaRoutesAccepting('extend')).toEqual([]);
    for (const entry of MEDIA_ROUTE_CAPABILITIES) {
      expect(
        checkMediaRouteConditioning({ route: entry, conditioning: { mode: 'extend' } }).ok,
      ).toBe(false);
    }
  });

  it('reports an unwired route key as unknown rather than as a capability', () => {
    expect(mediaRouteCapability('higgsfield-turbo')).toBeUndefined();
  });
});
