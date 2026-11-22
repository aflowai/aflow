/**
 * The resolutions and the openings one trading day's cycle docs record,
 * across every slot of the day. The close report's ledger read lists both,
 * and the close report counts its theses formed and resolved from that
 * recorded list. The reflection gives one reason per resolution. Both
 * contracts hold their lists to the cycle docs through the rules here, so no
 * entry names a thesis, an outcome or a slot the ledger does not record. The
 * runtime registers each rule as a validatorRef over the space's cycle docs.
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

/** One thesis a cycle doc of the day lists as opened, with the cycle doc and its slot. */
export interface DayOpening {
  cycleDocPath: string;
  slotKey: string;
  thesisId: string;
}

export interface DayResolutionsReading {
  resolutions: DayResolution[];
  opened: DayOpening[];
  /** A cycle doc of the day whose resolutions or openings cannot be read, with why. */
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

/** Why a cycle doc of the day cannot be read, or null where it can. */
function unreadable(body: Record<string, unknown> | null): string | null {
  if (body === null) return 'its content is not an inline JSON object';
  const resolved = body['thesesResolved'];
  if (!Array.isArray(resolved)) return 'it holds no thesesResolved list';
  if (!resolved.map(asRecord).every(isResolutionEntry)) {
    return `an entry of its thesesResolved has no thesisId, hypothesisId or outcome of ${RESOLUTION_OUTCOMES.join(', ')}`;
  }
  const opened = body['thesesOpened'];
  if (!Array.isArray(opened) || !opened.every(isText)) {
    return 'it holds no thesesOpened list of thesisIds';
  }
  return null;
}

/**
 * Every resolution and every opening the day's cycle docs record, in path
 * order. A cycle doc of the day that cannot be read is refused, never
 * skipped: a skipped doc would drop what it records.
 */
export function readDayResolutions(
  docs: readonly CycleLedgerDoc[],
  tradingDay: string,
): DayResolutionsReading {
  const reading: DayResolutionsReading = { resolutions: [], opened: [], refused: [] };
  const ofDay = docs
    .map((doc) => ({ doc, slotKey: cycleDocSlotKey(doc.path, tradingDay) }))
    .filter((entry): entry is { doc: CycleLedgerDoc; slotKey: string } => entry.slotKey !== null)
    .sort((a, b) => (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0));
  for (const { doc, slotKey } of ofDay) {
    // A doc over the inline threshold is stored by reference, so it reads as
    // null here and is refused rather than read as recording nothing.
    const body = parse(doc.content);
    const reason = unreadable(body);
    if (body === null || reason !== null) {
      reading.refused.push({
        path: doc.path,
        reason: reason ?? 'its content is not an inline JSON object',
      });
      continue;
    }
    for (const entry of body['thesesResolved'] as Array<Record<string, string>>) {
      reading.resolutions.push({
        cycleDocPath: doc.path,
        slotKey,
        thesisId: entry['thesisId']!,
        hypothesisId: entry['hypothesisId']!,
        outcome: entry['outcome']!,
      });
    }
    for (const thesisId of body['thesesOpened'] as string[]) {
      reading.opened.push({ cycleDocPath: doc.path, slotKey, thesisId });
    }
  }
  return reading;
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

/** One list an output holds, and what the day's cycle docs record for it. */
interface DayList {
  field: string;
  expected: ReadonlyArray<DayResolution | DayOpening>;
  /** The fields an entry carries as its cycle doc records them. */
  compared: readonly string[];
  /** The cycle doc list its entries come from: thesesResolved or thesesOpened. */
  docList: 'thesesResolved' | 'thesesOpened';
}

const verbOf = (list: DayList) => (list.docList === 'thesesResolved' ? 'resolved' : 'opened');

/**
 * One issue per entry of a list the day's cycle docs do not record as it
 * stands, per duplicate, and per entry the list leaves out. An entry is one
 * thesis at one slot, so it matches on its thesisId and its slotKey and then
 * carries the `compared` fields.
 */
function listIssues(
  listed: readonly ListedEntry[],
  tradingDay: string,
  list: DayList,
): DayResolutionIssue[] {
  const { field } = list;
  const verb = verbOf(list);
  const issues: DayResolutionIssue[] = [];
  const expected = new Map(list.expected.map((r) => [keyOf(r), r]));
  const slotsOf = new Map<string, string[]>();
  for (const r of list.expected) {
    slotsOf.set(r.thesisId, [...(slotsOf.get(r.thesisId) ?? []), r.slotKey]);
  }
  const seen = new Set<string>();
  listed.forEach((entry, i) => {
    const key = keyOf(entry);
    if (seen.has(key)) {
      issues.push({
        path: [field, i],
        message: `Thesis "${entry.thesisId}" at slot ${entry.slotKey} is listed more than once. Give each one entry.`,
      });
      return;
    }
    seen.add(key);
    const want = expected.get(key);
    if (want === undefined) {
      const slots = slotsOf.get(entry.thesisId);
      issues.push({
        path: [field, i, slots === undefined ? 'thesisId' : 'slotKey'],
        message:
          slots === undefined
            ? `No cycle doc of ${tradingDay} records thesis "${entry.thesisId}" ${verb}. List only the theses the day's cycle docs list in ${list.docList}.`
            : `Thesis "${entry.thesisId}" ${verb} at slot ${slots.join(', ')} on ${tradingDay}, not at ${entry.slotKey}. Give the slot key of the cycle doc that records it.`,
      });
      return;
    }
    const recorded = want as unknown as Record<string, unknown>;
    for (const compared of list.compared) {
      if (entry.fields[compared] === recorded[compared]) continue;
      issues.push({
        path: [field, i, compared],
        message: `The cycle doc ${want.cycleDocPath} records thesis "${want.thesisId}" with ${compared} ${JSON.stringify(recorded[compared])}. Give that ${compared}.`,
      });
    }
  });
  for (const want of list.expected) {
    if (seen.has(keyOf(want))) continue;
    issues.push({
      path: [field],
      message: `The cycle doc ${want.cycleDocPath} lists thesis "${want.thesisId}" in ${list.docList}, and ${field} leaves it out. Add one entry for it.`,
    });
  }
  return issues;
}

/**
 * The issues of each list an output holds against the day's cycle docs. A
 * cycle doc of the day that cannot be read refuses every list.
 */
function dayIssues(
  data: unknown,
  docs: readonly CycleLedgerDoc[],
  listsOf: (reading: DayResolutionsReading) => readonly DayList[],
): DayResolutionIssue[] {
  const output = asRecord(data);
  const tradingDay = output?.['tradingDay'];
  // The contract's JSON Schema refuses a malformed output.
  if (typeof tradingDay !== 'string' || !TRADING_DAY.test(tradingDay)) return [];
  const reading = readDayResolutions(docs, tradingDay);
  if (reading.refused.length > 0) {
    return reading.refused.map((doc) => ({
      path: [],
      message: `The cycle doc ${doc.path} of ${tradingDay} cannot be read: ${doc.reason}. No list of the day passes until the operator corrects it. Stop and report its path.`,
    }));
  }
  return listsOf(reading).flatMap((list) => {
    const listed = listedEntries(output?.[list.field]);
    return listed === null ? [] : listIssues(listed, tradingDay, list);
  });
}

/**
 * The close report's ledger read lists every resolution and every opening of
 * the day, each as its cycle doc records it.
 */
export function dayResolutionIssues(
  data: unknown,
  docs: readonly CycleLedgerDoc[],
): DayResolutionIssue[] {
  return dayIssues(data, docs, (reading) => [
    {
      field: 'resolutions',
      expected: reading.resolutions,
      compared: ['cycleDocPath', 'hypothesisId', 'outcome'],
      docList: 'thesesResolved',
    },
    {
      field: 'thesesOpened',
      expected: reading.opened,
      compared: ['cycleDocPath'],
      docList: 'thesesOpened',
    },
  ]);
}

/** The reflection gives one reason per resolution of the day, each naming its thesis, outcome and slot. */
export function closeReasonIssues(
  data: unknown,
  docs: readonly CycleLedgerDoc[],
): DayResolutionIssue[] {
  return dayIssues(data, docs, (reading) => [
    {
      field: 'reasons',
      expected: reading.resolutions,
      compared: ['hypothesisId', 'outcome'],
      docList: 'thesesResolved',
    },
  ]);
}
