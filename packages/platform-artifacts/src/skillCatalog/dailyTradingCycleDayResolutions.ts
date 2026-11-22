/**
 * The resolutions one trading day's cycle docs record, across every slot of
 * the day. The close report's ledger read lists them, and the reflection gives
 * one reason per resolution. Both contracts hold their lists to the cycle docs
 * through the rules here, so no entry names a thesis, an outcome or a slot the
 * ledger does not record. The runtime registers each rule as a validatorRef
 * over the space's cycle docs.
 */
import { RESOLUTION_OUTCOMES, SLOT_KEY_PATTERN } from './dailyTradingCycleSlots.js';

export const DAY_RESOLUTIONS_VALIDATOR_REF = 'trading.day-resolutions' as const;
export const CLOSE_REASONS_VALIDATOR_REF = 'trading.close-reasons' as const;

const CYCLES_PREFIX = '/portfolio/theses/cycles/';
const TRADING_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** One cycle doc as stored: its path and its JSON text. */
export interface CycleLedgerDoc {
  path: string;
  content: string | null;
}

/** One resolution a cycle doc of the day records, with the cycle doc and its slot. */
export interface DayResolution {
  cycleDocPath: string;
  slotKey: string;
  thesisId: string;
  hypothesisId: string;
  outcome: string;
}

export interface DayResolutionsReading {
  resolutions: DayResolution[];
  /** A cycle doc of the day whose resolutions cannot be read, with why. */
  refused: Array<{ path: string; reason: string }>;
}

export interface DayResolutionIssue {
  path: Array<string | number>;
  message: string;
}

/** The slot key a cycle doc path of the trading day names, or null where it is no such path. */
export function cycleDocSlotKey(path: string, tradingDay: string): string | null {
  if (!TRADING_DAY.test(tradingDay)) return null;
  const match = new RegExp(`^${CYCLES_PREFIX}${tradingDay}-${SLOT_KEY_PATTERN}\\.json$`).exec(path);
  return match?.[1] ?? null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parse(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function isResolutionEntry(entry: Record<string, unknown> | null): entry is Record<string, string> {
  return (
    entry !== null &&
    isText(entry['thesisId']) &&
    isText(entry['hypothesisId']) &&
    (RESOLUTION_OUTCOMES as readonly unknown[]).includes(entry['outcome'])
  );
}

/**
 * Every resolution the day's cycle docs record, in path order. A cycle doc of
 * the day whose thesesResolved cannot be read is refused, never skipped: a
 * skipped doc would drop the resolutions it records.
 */
export function readDayResolutions(
  docs: readonly CycleLedgerDoc[],
  tradingDay: string,
): DayResolutionsReading {
  const resolutions: DayResolution[] = [];
  const refused: DayResolutionsReading['refused'] = [];
  const ofDay = docs
    .map((doc) => ({ doc, slotKey: cycleDocSlotKey(doc.path, tradingDay) }))
    .filter((entry): entry is { doc: CycleLedgerDoc; slotKey: string } => entry.slotKey !== null)
    .sort((a, b) => (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0));
  for (const { doc, slotKey } of ofDay) {
    // A doc over the inline threshold is stored by reference, so it reads as
    // null here and is refused rather than read as resolving nothing.
    const body = parse(doc.content);
    if (body === null) {
      refused.push({ path: doc.path, reason: 'its content is not an inline JSON object' });
      continue;
    }
    const listed = body['thesesResolved'];
    if (!Array.isArray(listed)) {
      refused.push({ path: doc.path, reason: 'it holds no thesesResolved list' });
      continue;
    }
    const entries = listed.map(asRecord);
    if (!entries.every(isResolutionEntry)) {
      refused.push({
        path: doc.path,
        reason: `an entry of its thesesResolved has no thesisId, hypothesisId or outcome of ${RESOLUTION_OUTCOMES.join(', ')}`,
      });
      continue;
    }
    for (const entry of entries) {
      resolutions.push({
        cycleDocPath: doc.path,
        slotKey,
        thesisId: entry['thesisId']!,
        hypothesisId: entry['hypothesisId']!,
        outcome: entry['outcome']!,
      });
    }
  }
  return { resolutions, refused };
}

const keyOf = (item: { slotKey: string; thesisId: string }) => `${item.slotKey}#${item.thesisId}`;

interface ListedEntry {
  thesisId: string;
  slotKey: string;
  fields: Record<string, unknown>;
}

function listedEntries(list: unknown): ListedEntry[] | null {
  if (!Array.isArray(list)) return null;
  const entries = list.map(asRecord);
  const listed: ListedEntry[] = [];
  for (const fields of entries) {
    if (fields === null || !isText(fields['thesisId']) || !isText(fields['slotKey'])) return null;
    listed.push({ thesisId: fields['thesisId'], slotKey: fields['slotKey'], fields });
  }
  return listed;
}

/**
 * One issue per entry of `listField` the day's cycle docs do not record as it
 * stands, per duplicate, and per resolution the list leaves out. An entry is
 * a resolution at one slot, so it matches on its thesisId and its slotKey and
 * then carries the resolution's `compared` fields.
 */
function matchIssues(
  data: unknown,
  docs: readonly CycleLedgerDoc[],
  listField: string,
  compared: ReadonlyArray<keyof DayResolution>,
): DayResolutionIssue[] {
  const output = asRecord(data);
  const tradingDay = output?.['tradingDay'];
  const listed = listedEntries(output?.[listField]);
  // The contract's JSON Schema refuses a malformed output.
  if (typeof tradingDay !== 'string' || !TRADING_DAY.test(tradingDay) || listed === null) {
    return [];
  }
  const reading = readDayResolutions(docs, tradingDay);
  if (reading.refused.length > 0) {
    return reading.refused.map((doc) => ({
      path: [],
      message: `The cycle doc ${doc.path} of ${tradingDay} cannot be read: ${doc.reason}. No list of the day's resolutions passes until the operator corrects it. Stop and report its path.`,
    }));
  }

  const issues: DayResolutionIssue[] = [];
  const expected = new Map(reading.resolutions.map((r) => [keyOf(r), r]));
  const slotsOf = new Map<string, string[]>();
  for (const r of reading.resolutions) {
    slotsOf.set(r.thesisId, [...(slotsOf.get(r.thesisId) ?? []), r.slotKey]);
  }
  const seen = new Set<string>();
  listed.forEach((entry, i) => {
    const key = keyOf(entry);
    if (seen.has(key)) {
      issues.push({
        path: [listField, i],
        message: `Thesis "${entry.thesisId}" at slot ${entry.slotKey} is listed more than once. Give each resolution one entry.`,
      });
      return;
    }
    seen.add(key);
    const want = expected.get(key);
    if (want === undefined) {
      const slots = slotsOf.get(entry.thesisId);
      issues.push({
        path: [listField, i, slots === undefined ? 'thesisId' : 'slotKey'],
        message:
          slots === undefined
            ? `No cycle doc of ${tradingDay} records thesis "${entry.thesisId}" resolved. List only the theses the day's cycle docs list in thesesResolved.`
            : `Thesis "${entry.thesisId}" resolved at slot ${slots.join(', ')} on ${tradingDay}, not at ${entry.slotKey}. Give the slot key of the cycle doc that records it.`,
      });
      return;
    }
    for (const field of compared) {
      if (entry.fields[field] === want[field]) continue;
      issues.push({
        path: [listField, i, field],
        message: `The cycle doc ${want.cycleDocPath} records thesis "${want.thesisId}" with ${field} ${JSON.stringify(want[field])}. Give that ${field}.`,
      });
    }
  });
  for (const want of reading.resolutions) {
    if (seen.has(keyOf(want))) continue;
    issues.push({
      path: [listField],
      message: `The cycle doc ${want.cycleDocPath} records thesis "${want.thesisId}" resolved ${want.outcome}, and ${listField} leaves it out. Add one entry for it.`,
    });
  }
  return issues;
}

/** The close report's ledger read lists every resolution of the day, each as its cycle doc records it. */
export function dayResolutionIssues(
  data: unknown,
  docs: readonly CycleLedgerDoc[],
): DayResolutionIssue[] {
  return matchIssues(data, docs, 'resolutions', ['cycleDocPath', 'hypothesisId', 'outcome']);
}

/** The reflection gives one reason per resolution of the day, each naming its thesis, outcome and slot. */
export function closeReasonIssues(
  data: unknown,
  docs: readonly CycleLedgerDoc[],
): DayResolutionIssue[] {
  return matchIssues(data, docs, 'reasons', ['hypothesisId', 'outcome']);
}
