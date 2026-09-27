/**
 * What each wired media route can be conditioned on — the machine-readable
 * form of a constraint that otherwise lives in prose and is discovered at
 * dispatch, after the render is paid for.
 *
 * A descriptor states what the platform wiring delivers to the provider,
 * verified against the adapter that submits the request. That is the axis a
 * caller can act on: Sora's submit reads a first frame and never reads a last
 * one, so a clip asked to interpolate towards an end frame renders from the
 * first alone and bills in full. It is deliberately not a claim about what a
 * provider then does with what it was handed — a route nobody has wired for a
 * mode simply does not carry it.
 */
import { z } from 'zod';

/** What a reference image contributes to a generation. */
export const IMAGE_REFERENCE_ROLES = ['character', 'style'] as const;
export type ImageReferenceRole = (typeof IMAGE_REFERENCE_ROLES)[number];
export const ImageReferenceRoleSchema = z.enum(IMAGE_REFERENCE_ROLES);

/**
 * How a render is conditioned. The branches are disjoint: reference packs and
 * frame conditioning are separate shapes because no wired route reads both.
 */
export const MEDIA_CONDITIONING_MODES = ['prompt', 'reference', 'frames', 'extend'] as const;
export type MediaConditioningMode = (typeof MEDIA_CONDITIONING_MODES)[number];
export const MediaConditioningModeSchema = z.enum(MEDIA_CONDITIONING_MODES);

const MEDIA_ROUTE_KEYS = [
  'gpt-image',
  'grok-image',
  'google-flash-image',
  'google-pro-image',
  'google-veo',
  'google-veo-fast',
  'sora',
  'runware-kling',
  'runware-kling-pro',
] as const;
export type MediaRouteKey = (typeof MEDIA_ROUTE_KEYS)[number];
export const MediaRouteKeySchema = z.enum(MEDIA_ROUTE_KEYS);

export const MediaRouteCapabilitySchema = z.object({
  routeKey: MediaRouteKeySchema.describe('Model key spelled as the operation schema spells it'),
  medium: z.enum(['image', 'video']),
  /**
   * Reference packs the wiring delivers, per role. A role the map omits is a
   * role no reference reaches — the render would come back unconditioned.
   */
  references: z.record(ImageReferenceRoleSchema, z.number().int().positive()),
  /**
   * Routes that read references as named entities rather than one flat pack.
   *
   * The images are grouped by their label, and each group is one identity the
   * prompt names — so the bound that matters is how many identities a render
   * can carry, which `references` cannot express on its own. Absent means the
   * route reads the pack flat and a label is decoration.
   */
  referenceEntities: z
    .object({
      maxEntities: z.number().int().positive(),
      maxImagesPerEntity: z.number().int().positive(),
      /**
       * Whether an entity is only read in image-to-video mode. On a route that
       * says so, a render conditioned on characters and starting from the
       * prompt alone is refused rather than billed without them.
       */
      requiresFirstFrame: z.boolean(),
    })
    .optional(),
  /**
   * The source frames the wiring delivers, or absent when the route takes
   * none. `lastFrame: false` means a last frame is dropped before submit.
   */
  frames: z.object({ lastFrame: z.boolean() }).optional(),
  /** Provider-native continuation of a clip this route itself generated. */
  continuation: z.boolean(),
});
export type MediaRouteCapability = z.infer<typeof MediaRouteCapabilitySchema>;

/**
 * The wired routes. Nothing here is aspirational: `references` is populated
 * only where an adapter forwards them, `frames` only where a submit reads a
 * source frame, and `continuation` is false everywhere because no video
 * route returns a handle a later render could continue from.
 */
/**
 * The most images a route reading named entities can be handed at all. Derived
 * rather than restated: the two numbers move together, and a hand-written total
 * left behind makes the schema refuse a count the gate would have allowed.
 */
function entityCeiling(entities: { maxEntities: number; maxImagesPerEntity: number }): number {
  return entities.maxEntities * entities.maxImagesPerEntity;
}

const KLING_ENTITIES = { maxEntities: 3, maxImagesPerEntity: 4, requiresFirstFrame: true };

export const MEDIA_ROUTE_CAPABILITIES: readonly MediaRouteCapability[] = [
  { routeKey: 'gpt-image', medium: 'image', references: {}, continuation: false },
  { routeKey: 'grok-image', medium: 'image', references: {}, continuation: false },
  { routeKey: 'google-flash-image', medium: 'image', references: {}, continuation: false },
  {
    routeKey: 'google-pro-image',
    medium: 'image',
    // What the route documents it honours. A ceiling raised past that spends on
    // references the route will drop, so it moves when the vendor says so.
    references: { character: 5, style: 3 },
    continuation: false,
  },
  {
    routeKey: 'google-veo',
    medium: 'video',
    references: {},
    frames: { lastFrame: true },
    continuation: false,
  },
  {
    routeKey: 'google-veo-fast',
    medium: 'video',
    references: {},
    frames: { lastFrame: true },
    continuation: false,
  },
  {
    routeKey: 'sora',
    medium: 'video',
    references: {},
    frames: { lastFrame: false },
    continuation: false,
  },
  // Kling reads no flat reference pack at all — it rejects one outright. What
  // it reads is up to three named entities, each carrying a frontal image and
  // up to three further angles, and only when the render starts from a frame.
  {
    routeKey: 'runware-kling',
    medium: 'video',
    references: { character: entityCeiling(KLING_ENTITIES) },
    referenceEntities: KLING_ENTITIES,
    frames: { lastFrame: true },
    continuation: false,
  },
  {
    routeKey: 'runware-kling-pro',
    medium: 'video',
    references: { character: entityCeiling(KLING_ENTITIES) },
    referenceEntities: KLING_ENTITIES,
    frames: { lastFrame: true },
    continuation: false,
  },
];

const CAPABILITY_BY_ROUTE = new Map(
  MEDIA_ROUTE_CAPABILITIES.map((route) => [route.routeKey as string, route]),
);

/** The descriptor for a route key, or undefined when nothing is wired under it. */
export function mediaRouteCapability(routeKey: string): MediaRouteCapability | undefined {
  return CAPABILITY_BY_ROUTE.get(routeKey);
}

/**
 * A route's per-role reference ceiling as a total record, or undefined when it
 * reads no reference at all — the shape a model catalog and an executor gate
 * both consume, so neither carries its own copy of the numbers.
 */
export function mediaRouteReferenceLimits(
  routeKey: string,
): Readonly<Record<ImageReferenceRole, number>> | undefined {
  const route = mediaRouteCapability(routeKey);
  if (route === undefined || Object.keys(route.references).length === 0) return undefined;
  return Object.fromEntries(
    IMAGE_REFERENCE_ROLES.map((role) => [role, route.references[role] ?? 0]),
  ) as Record<ImageReferenceRole, number>;
}

/** Conditioning modes a route delivers — derived, never separately declared. */
export function mediaRouteConditioningModes(route: MediaRouteCapability): MediaConditioningMode[] {
  const modes: MediaConditioningMode[] = ['prompt'];
  if (Object.keys(route.references).length > 0) modes.push('reference');
  if (route.frames !== undefined) modes.push('frames');
  if (route.continuation) modes.push('extend');
  return modes;
}

/** Routes that deliver a conditioning mode — what an authoring surface offers. */
export function mediaRoutesAccepting(
  mode: MediaConditioningMode,
  medium?: MediaRouteCapability['medium'],
): MediaRouteCapability[] {
  return MEDIA_ROUTE_CAPABILITIES.filter(
    (route) =>
      (medium === undefined || route.medium === medium) &&
      mediaRouteConditioningModes(route).includes(mode),
  );
}

/**
 * Per-role ceiling across the routes of one medium — the bound that stops a
 * request no route could honour before it reaches a provider. The executor
 * still checks the resolved route's own descriptor, which is often lower.
 *
 * Scoped by medium because the two do not constrain each other: a generous
 * video route would otherwise raise what an image operation accepts, and the
 * schema would stop teaching the number any image model actually reads.
 */
export function maxReferencesPerRole(
  medium: MediaRouteCapability['medium'],
): Readonly<Record<ImageReferenceRole, number>> {
  return Object.fromEntries(
    IMAGE_REFERENCE_ROLES.map((role) => [
      role,
      Math.max(
        0,
        ...MEDIA_ROUTE_CAPABILITIES.filter((route) => route.medium === medium).map(
          (route) => route.references[role] ?? 0,
        ),
      ),
    ]),
  ) as Record<ImageReferenceRole, number>;
}

export const MAX_IMAGE_REFERENCES_PER_ROLE = maxReferencesPerRole('image');
export const MAX_VIDEO_REFERENCES_PER_ROLE = maxReferencesPerRole('video');

/** What a caller asks a route to condition on. */
export type MediaConditioningRequest =
  | { mode: 'prompt' }
  | {
      mode: 'reference';
      references: ReadonlyArray<{ role: ImageReferenceRole; label?: string | undefined }>;
      /**
       * Whether the render also starts from a frame. A route that reads its
       * entities only in image-to-video mode needs to know, and asking here
       * keeps that rule off every call site.
       */
      hasFirstFrame?: boolean | undefined;
    }
  | { mode: 'frames'; lastFrame: boolean }
  | { mode: 'extend' };

/**
 * References grouped into the entities a route names, in the order they first
 * appear. Grouping is by label because that is what the prompt says out loud —
 * two images of one character are one identity, not two.
 */
export function groupReferencesByEntity<T extends { label?: string | undefined }>(
  references: readonly T[],
): Array<{ label: string; references: T[] }> {
  const byLabel = new Map<string, T[]>();
  for (const reference of references) {
    const label = reference.label ?? '';
    const existing = byLabel.get(label);
    if (existing === undefined) byLabel.set(label, [reference]);
    else existing.push(reference);
  }
  return [...byLabel].map(([label, grouped]) => ({ label, references: grouped }));
}

export type MediaConditioningVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a route can honour a conditioning request. Every refusal names what
 * the route does not deliver and which wired routes do, because the caller's
 * next move is choosing a different route or dropping the conditioning.
 */
export function checkMediaRouteConditioning(params: {
  route: MediaRouteCapability;
  conditioning: MediaConditioningRequest;
}): MediaConditioningVerdict {
  const { route, conditioning } = params;
  switch (conditioning.mode) {
    case 'prompt':
      return { ok: true };
    case 'reference':
      return checkReferences(route, conditioning.references, conditioning.hasFirstFrame === true);
    case 'frames':
      return checkFrames(route, conditioning.lastFrame);
    case 'extend':
      return {
        ok: false,
        reason: `'${route.routeKey}' returns no handle a later render could continue from${alternatives('extend', route)}. A longer sequence means rendering further clips and assembling them.`,
      };
  }
}

function checkReferences(
  route: MediaRouteCapability,
  references: ReadonlyArray<{ role: ImageReferenceRole; label?: string | undefined }>,
  hasFirstFrame: boolean,
): MediaConditioningVerdict {
  const entities = route.referenceEntities;
  if (entities !== undefined && references.length > 0) {
    if (entities.requiresFirstFrame && !hasFirstFrame) {
      return {
        ok: false,
        reason: `'${route.routeKey}' reads its references only as part of animating a starting frame, so a render from the prompt alone would be billed without any of them. Give the shot a first frame, or drop the references.`,
      };
    }
    const groups = groupReferencesByEntity(references);
    const unlabelled = groups.find((group) => group.label === '');
    if (unlabelled !== undefined) {
      return {
        ok: false,
        reason: `'${route.routeKey}' names each reference in the prompt, so every one needs a label the prompt uses. ${String(unlabelled.references.length)} reference(s) carry none.`,
      };
    }
    if (groups.length > entities.maxEntities) {
      return {
        ok: false,
        reason: `'${route.routeKey}' carries at most ${String(entities.maxEntities)} named references in one shot; ${String(groups.length)} were given (${groups.map((group) => `'${group.label}'`).join(', ')}). The extra ones are ignored rather than blended, so the render would come back missing them.`,
      };
    }
    const overfull = groups.find((group) => group.references.length > entities.maxImagesPerEntity);
    if (overfull !== undefined) {
      return {
        ok: false,
        reason: `'${route.routeKey}' reads at most ${String(entities.maxImagesPerEntity)} images per named reference; '${overfull.label}' has ${String(overfull.references.length)}.`,
      };
    }
  }
  for (const role of IMAGE_REFERENCE_ROLES) {
    const asked = references.filter((reference) => reference.role === role).length;
    const limit = route.references[role] ?? 0;
    if (asked <= limit) continue;
    if (limit === 0) {
      return {
        ok: false,
        reason: `'${route.routeKey}' reads no ${role} reference, so it would generate from the prompt alone with none of the asked-for consistency${alternatives('reference', route)}.`,
      };
    }
    return {
      ok: false,
      reason: `'${route.routeKey}' reads at most ${String(limit)} ${role} reference(s); ${String(asked)} were asked for, and the extra ones are ignored rather than blended.`,
    };
  }
  return { ok: true };
}

function checkFrames(route: MediaRouteCapability, lastFrame: boolean): MediaConditioningVerdict {
  if (route.frames === undefined) {
    return {
      ok: false,
      reason: `'${route.routeKey}' takes no source frame${alternatives('frames', route)}.`,
    };
  }
  if (lastFrame && !route.frames.lastFrame) {
    const interpolating = mediaRoutesAccepting('frames', route.medium)
      .filter((candidate) => candidate.frames?.lastFrame === true)
      .map((candidate) => `'${candidate.routeKey}'`);
    return {
      ok: false,
      reason:
        `'${route.routeKey}' reads only the first frame — a last frame never reaches it, so the clip ` +
        `renders uninterpolated and bills in full` +
        `${interpolating.length > 0 ? `. Routes that interpolate: ${interpolating.join(', ')}` : ''}.`,
    };
  }
  return { ok: true };
}

function alternatives(mode: MediaConditioningMode, route: MediaRouteCapability): string {
  const keys = mediaRoutesAccepting(mode, route.medium).map(
    (candidate) => `'${candidate.routeKey}'`,
  );
  if (keys.length === 0) return `, and no wired ${route.medium} route does`;
  return `. Routes that do: ${keys.join(', ')}`;
}

/**
 * The route keys of one medium, in declaration order.
 *
 * Derived from the wired descriptors rather than restated: a media model is
 * selectable exactly when a route carries it, so a hand-kept list could offer
 * a model the dispatcher has no wiring for — a render that bills before the
 * missing route is discovered.
 */
function routeKeysFor(medium: 'image' | 'video'): readonly [MediaRouteKey, ...MediaRouteKey[]] {
  const [first, ...rest] = MEDIA_ROUTE_CAPABILITIES.filter((entry) => entry.medium === medium).map(
    (entry) => entry.routeKey,
  );
  if (first === undefined) throw new Error(`No wired ${medium} route`);
  return [first, ...rest];
}

export const IMAGE_ROUTE_KEYS = routeKeysFor('image');
export const VIDEO_ROUTE_KEYS = routeKeysFor('video');
