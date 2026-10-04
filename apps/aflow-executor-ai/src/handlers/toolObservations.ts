import {
  ClearedObservationSchema,
  ToolResultObservationSchema,
  staleFieldsOf,
  type AiContentPart,
  type AiMessageAtomV1,
  type AiMessageV1,
  type AiToolResultEnvelopeV1,
  type ClearedObservation,
  type StampedFacet,
  type ToolResultObservation,
} from '@aflow/schemas';

interface ObservedResult {
  partIndex: number;
  envelope: Omit<AiToolResultEnvelopeV1, 'observation'>;
  /** Undefined when the stamp does not parse: the result is shown in full. */
  observation: ToolResultObservation | undefined;
}

/** The first later result that made a facet stale, and how. */
interface Staleness {
  index: number;
  cause: 'replaced' | 'moved' | 'ended';
  operation: string;
}

/** A later look at one part of a facet, and what it left out of that part. */
interface LaterLook {
  withheld: number;
  staleness: Staleness;
}

/**
 * The first later look that replaced `facet`: the nearest one when what the
 * facet holds expires at any later look, else the nearest that left out no
 * more of the part than it did.
 */
function firstReplacing(looks: readonly LaterLook[], facet: StampedFacet): Staleness | undefined {
  if (facet.expires === 'on_any_later_look') return looks[0]?.staleness;
  return looks.find((look) => look.withheld <= facet.withheld)?.staleness;
}

/**
 * `looks` stays in result order, nearest first, holding only looks that left
 * out less than every nearer one: a further look leaving out as much or more
 * covers nothing a nearer one does not.
 */
function withNearerLook(looks: readonly LaterLook[], look: LaterLook): LaterLook[] {
  return [look, ...looks.filter((later) => later.withheld < look.withheld)];
}

function observedResultOf(message: AiMessageV1): ObservedResult | undefined {
  if (message.role !== 'tool') return undefined;
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.kind !== 'json') continue;
    const json = part.json as Record<string, unknown> | null;
    if (json?.['kind'] !== 'tool_result' || json['observation'] === undefined) continue;
    const observation = ToolResultObservationSchema.safeParse(json['observation']);
    const { observation: _stamp, ...envelope } = json as unknown as AiToolResultEnvelopeV1;
    return { partIndex, envelope, observation: observation.success ? observation.data : undefined };
  }
  return undefined;
}

/** A cleared exchange's note: what it shows, and what its results observed, in their order. */
function clearedObservationsOf(
  message: AiMessageV1,
): { shown: AiContentPart[]; observations: ClearedObservation[] } | undefined {
  const shown: AiContentPart[] = [];
  const observations: ClearedObservation[] = [];
  for (const part of message.parts) {
    const json = part.kind === 'json' ? (part.json as Record<string, unknown> | null) : null;
    if (json?.['kind'] !== 'cleared_observation') {
      shown.push(part);
      continue;
    }
    const parsed = ClearedObservationSchema.safeParse(json);
    if (parsed.success) observations.push(parsed.data);
  }
  return shown.length === message.parts.length ? undefined : { shown, observations };
}

const observedOperation = (envelope: Pick<AiToolResultEnvelopeV1, 'operationId' | 'toolName'>) =>
  envelope.operationId ?? envelope.toolName;

/**
 * What a tool result observed, kept on the note that replaces it when its
 * exchange is cleared; nothing for a result without a stamp that parses.
 */
export function clearedObservationOf(message: AiMessageV1): ClearedObservation | undefined {
  const observed = observedResultOf(message);
  if (observed?.observation === undefined) return undefined;
  const { receipts: _receipts, ...observation } = observed.observation;
  return {
    kind: 'cleared_observation',
    operation: observedOperation(observed.envelope),
    observation,
  };
}

const thingSlot = (group: string, key: string) => `${group}\u0000${key}`;

const facetSlot = (group: string, facet: StampedFacet) =>
  [group, facet.key, facet.facet, ...facet.part.map((p) => p.value)].join('\u0000');

function facetName(facet: StampedFacet): string {
  const parts = facet.part
    .filter((p) => p.value !== '')
    .map((p) => `${p.path.split('.').at(-1)!} ${p.value}`);
  return parts.length === 0 ? facet.facet : `${facet.facet} (${parts.join(', ')})`;
}

function staleLine(facet: StampedFacet, staleness: Staleness, operations: string[]): string {
  switch (staleness.cause) {
    case 'replaced':
      return (
        `A later ${facetName(facet)} of ${facet.key} replaced this result's; ` +
        `${facet.currentStateOperation} returns the current one.`
      );
    case 'moved':
      return (
        `${staleness.operation} moved ${facet.key} to another address after this result, so ` +
        `nothing this result observed of ${facet.key} is kept; ${operations.join(' and ')} ` +
        `return${operations.length === 1 ? 's' : ''} it as it is now.`
      );
    case 'ended':
      return (
        `${staleness.operation} ended ${facet.key} after this result, so nothing this result observed ` +
        `of ${facet.key} is kept.`
      );
  }
}

/** One line per facet that went stale, a move or an end said once for the facets it covers. */
function staleLines(facets: StampedFacet[], stale: Map<number, Staleness>): string[] {
  const lines = new Set<string>();
  for (const [index, staleness] of [...stale].sort(([a], [b]) => a - b)) {
    const facet = facets[index]!;
    const operations = [
      ...new Set(
        facets
          .filter((other) => other.key === facet.key)
          .map((other) => other.currentStateOperation),
      ),
    ];
    lines.add(staleLine(facet, staleness, operations));
  }
  return [...lines];
}

function earlier(a: Staleness | undefined, b: Staleness | undefined): Staleness | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // A result that both replaces a facet and moves the page says it moved.
  return b.index < a.index || (b.index === a.index && b.cause !== 'replaced') ? b : a;
}

/**
 * The messages as the model is shown them. A stamped tool result is reduced
 * only in the facets a later result replaced — the same facet of the same
 * thing, with the same part keys, and for a facet whose content expires only
 * when covered, leaving out no more of that part than this result did — and
 * in every facet once a later result moved its thing to another address or
 * ended it. A reduced result is its
 * receipt for the fields it no longer shows, under one line per stale facet
 * naming what made it stale. The stamp itself is never shown.
 *
 * A pure function of the list. What a result shows depends only on which of
 * its facets are stale and on the first later result that made each so —
 * which never changes once it exists, because a cleared result's note carries
 * what it observed and counts as that result — so a result changes form at
 * most once per facet and is identical on every turn after. A note is never
 * reduced: it is the last word on what its results observed until a later look.
 */
export function renderToolObservations(messages: readonly AiMessageV1[]): AiMessageV1[] {
  const laterLooks = new Map<string, LaterLook[]>();
  const movedOrEndedBy = new Map<string, Staleness>();
  const recordLook = (
    { group, facets, moved, ended }: Omit<ToolResultObservation, 'receipts'>,
    index: number,
    operation: string,
  ) => {
    for (const facet of facets) {
      const slot = facetSlot(group, facet);
      laterLooks.set(
        slot,
        withNearerLook(laterLooks.get(slot) ?? [], {
          withheld: facet.expires === 'on_covering_look' ? facet.withheld : 0,
          staleness: { index, cause: 'replaced', operation },
        }),
      );
    }
    for (const key of moved) {
      movedOrEndedBy.set(thingSlot(group, key), { index, cause: 'moved', operation });
    }
    for (const key of ended) {
      movedOrEndedBy.set(thingSlot(group, key), { index, cause: 'ended', operation });
    }
  };
  const rendered: AiMessageV1[] = new Array<AiMessageV1>(messages.length);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const cleared = clearedObservationsOf(message);
    if (cleared !== undefined) {
      rendered[index] = { ...message, parts: cleared.shown };
      // The note stands where its results stood, so each one still counts as
      // the later look it was, in the order the results came.
      const { observations } = cleared;
      for (let i = observations.length - 1; i >= 0; i -= 1) {
        const { observation, operation } = observations[i]!;
        recordLook(observation, index + i / observations.length, operation);
      }
      continue;
    }
    const observed = observedResultOf(message);
    if (observed === undefined) {
      rendered[index] = message;
      continue;
    }
    const { partIndex, envelope, observation } = observed;
    const full: AiMessageV1 = {
      ...message,
      parts: message.parts.map((part, i): AiContentPart =>
        i === partIndex ? { kind: 'json', json: envelope } : part,
      ),
    };
    if (observation === undefined) {
      rendered[index] = full;
      continue;
    }

    const { group, facets } = observation;
    const stale = new Map<number, Staleness>();
    for (const [i, facet] of facets.entries()) {
      const first = earlier(
        firstReplacing(laterLooks.get(facetSlot(group, facet)) ?? [], facet),
        movedOrEndedBy.get(thingSlot(group, facet.key)),
      );
      if (first !== undefined) stale.set(i, first);
    }
    const without = staleFieldsOf(facets, new Set(stale.keys()));
    const receipt = observation.receipts.find(
      (r) => r.without.length === without.length && r.without.every((f, i) => f === without[i]),
    );
    if (without.length === 0 || receipt === undefined) {
      rendered[index] = full;
    } else {
      const { images: _images, imagesWithheld: _withheld, ...receiptEnvelope } = envelope;
      const lines = staleLines(facets, stale);
      rendered[index] = {
        ...message,
        parts: [
          {
            kind: 'json',
            json: { ...receiptEnvelope, summary: `${lines.join('\n')}\n${receipt.text}` },
          },
        ],
      };
    }

    recordLook(observation, index, observedOperation(envelope));
  }
  return rendered;
}

/**
 * The atoms as the model is sent them, each message rendered by
 * `renderToolObservations` over the whole list. Assembly, compaction and
 * clearing all measure history through this, so none of them counts what a
 * reduced result no longer shows.
 */
export function atomsAsSent(atoms: readonly AiMessageAtomV1[]): AiMessageAtomV1[] {
  const sent = renderToolObservations(atoms.map((atom) => atom.message));
  return atoms.map((atom, i) => ({ ...atom, message: sent[i]! }));
}
