'use client';

/**
 * A harness step, while it works and once it is done.
 *
 * A harness runs for minutes and says nothing until the end, so the wait is
 * the whole of the experience: what it is reading, what it tried, how the call
 * came back. This is that wait, under the step rather than inside the agent's
 * message — an executor's view of its own work is not the run speaking.
 *
 * One component, two places: the step row in the timeline and the task row in
 * a run. Both show the same thing, because they are the same thing.
 *
 * Nothing vanishes when the step ends. The answer takes the top and the feed
 * folds to its counts under it, so a reader who arrives late reads what came of
 * the work first and can still open how it was reached.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { HarnessActivityLineSchema, type HarnessActivityLine } from '@aflow/schemas';
import type { HarnessActivityState } from '@aflow/run-view';
import { Badge, Icon, Spinner, Text } from '@aflow/design-system';

import { fetchPayload } from '../lib/fetch-payload.js';
import { harnessCardTitle, readHarnessId, readResultHarness } from '../lib/harness-title.js';
import { useApi } from './providers.js';
import {
  HostHarnessBody,
  HostHarnessHeader,
  formatDuration,
  isHostHarnessResult,
  type HostHarnessResult,
} from './host/HostOutputCard.js';
import './harness-activity-card.css';

export const HARNESS_RUN_OPERATION = 'host.harness.run';

// ---------------------------------------------------------------------------
// The live feed, as the run-view fold holds it
// ---------------------------------------------------------------------------

const NO_FEEDS: Record<string, HarnessActivityState> = {};
const NO_LINES: HarnessActivityLine[] = [];

interface HarnessActivityContextValue {
  feeds: Record<string, HarnessActivityState>;
  /**
   * Whether the channel the feeds arrive on is up.
   *
   * Down, an empty feed says nothing about the harness — only about this tab —
   * and the card has to say which. True by default: a surface that mounts no
   * reducer reads the stored feed and has no live channel to be wrong about.
   */
  live: boolean;
}

/**
 * The feeds of every step in the session being watched.
 *
 * A context rather than a prop because the step row is many components below
 * the hook that folds the deltas, and every component in between would
 * otherwise carry a value that is none of its business. Its default is empty:
 * a surface that mounts no reducer — a run opened on its own page — shows the
 * stored feed instead, and nothing has to know which surface it is on.
 */
const HarnessActivityContext = createContext<HarnessActivityContextValue>({
  feeds: NO_FEEDS,
  live: true,
});

export function HarnessActivityProvider({
  feeds,
  live,
  children,
}: {
  feeds: Record<string, HarnessActivityState>;
  live: boolean;
  children: ReactNode;
}): ReactNode {
  const value = useMemo(() => ({ feeds, live }), [feeds, live]);
  return (
    <HarnessActivityContext.Provider value={value}>{children}</HarnessActivityContext.Provider>
  );
}

export function useHarnessActivityLines(
  stepExecutionId: string | undefined,
): HarnessActivityLine[] {
  const { feeds } = useContext(HarnessActivityContext);
  if (stepExecutionId === undefined) return NO_LINES;
  return feeds[stepExecutionId]?.lines ?? NO_LINES;
}

/** Every feed this surface holds — for a row that reads many at once. */
/**
 * The card for one step, reading that step's feed from the surface's provider.
 * The chat renders it while the step runs and again on the step's result, so
 * the feed a person watched is the one folded above the result.
 */
export function HarnessStepCard({
  stepExecutionId,
  running,
  result,
}: {
  stepExecutionId: string | undefined;
  running: boolean;
  result?: HostHarnessResult | undefined;
}): ReactNode {
  const lines = useHarnessActivityLines(stepExecutionId);
  return (
    <HarnessActivityCard
      lines={lines}
      running={running}
      result={result}
      stepExecutionId={stepExecutionId}
    />
  );
}

export function useHarnessActivityFeeds(): Record<string, HarnessActivityState> {
  return useContext(HarnessActivityContext).feeds;
}

export function useHarnessFeedsLive(): boolean {
  return useContext(HarnessActivityContext).live;
}

// ---------------------------------------------------------------------------
// Reading a feed
// ---------------------------------------------------------------------------

export interface ActivityCounts {
  events: number;
  /** Times it spoke. A turn spent entirely on tools shows as its calls. */
  turns: number;
  toolCalls: number;
  /** Milliseconds since the run started, as of the last line. */
  elapsedMs: number;
}

export function activityCounts(lines: HarnessActivityLine[]): ActivityCounts {
  let turns = 0;
  let toolCalls = 0;
  for (const line of lines) {
    if (line.kind === 'thought') turns += 1;
    if (line.kind === 'tool') toolCalls += 1;
  }
  return {
    events: lines.length,
    turns,
    toolCalls,
    elapsedMs: lines[lines.length - 1]?.at ?? 0,
  };
}

/** `Read src/parser.ts` — the tool is emphasised, the rest is what it was given. */
export function splitToolLine(line: { tool: string; text: string }): {
  tool: string;
  detail: string;
} {
  const detail = line.text.startsWith(line.tool) ? line.text.slice(line.tool.length) : line.text;
  return { tool: line.tool, detail: detail.trim() };
}

/**
 * The folded header of a finished run.
 *
 * What the run did, in the two measures a reader decides on: the calls it made
 * and the times it stopped to say something. A stored feed is read only when a
 * reader opens it, so a count of zero before that would claim the run did
 * nothing — say `activity` until the feed is in hand, and say plainly when
 * there is none.
 */
export function foldHeaderText(counts: ActivityCounts, storedFeedExists: boolean): string {
  const parts: string[] = [];
  if (counts.toolCalls > 0) {
    parts.push(`${String(counts.toolCalls)} tool call${counts.toolCalls === 1 ? '' : 's'}`);
  }
  if (counts.turns > 0) parts.push(`${String(counts.turns)} note${counts.turns === 1 ? '' : 's'}`);
  if (parts.length > 0) return parts.join(' · ');
  if (counts.events > 0) {
    return `${String(counts.events)} event${counts.events === 1 ? '' : 's'}`;
  }
  return storedFeedExists ? 'activity' : 'no activity recorded';
}

/**
 * Which half of the card leads.
 *
 * While it runs the feed is the only thing there is to read. Once it is done the
 * answer is, and a reader arriving at the end should not have to scroll a
 * transcript of how it was reached to find what it was.
 */
export function leadingSection(opts: { running: boolean; hasResult: boolean }): 'feed' | 'result' {
  return !opts.running && opts.hasResult ? 'result' : 'feed';
}

/**
 * How much of a tool row fits one line, in characters.
 *
 * What actually fits is the browser's to know, and asking it per row would read
 * layout on every line of a feed that grows while it is watched. This is the
 * narrowest column the card renders in at the feed's size: under it the ellipsis
 * never appears, over it the chevron is offered and the ellipsis decides.
 */
const ROW_FITS_CHARS = 72;

/**
 * Whether a row has more to say than the line it is given.
 *
 * Read off the normalized line rather than the tool, so a second coding agent
 * costs nothing here.
 */
export function lineNeedsExpansion(line: HarnessActivityLine): boolean {
  if (line.kind !== 'tool' && line.kind !== 'tool_result') return false;
  return line.text.includes('\n') || line.text.length > ROW_FITS_CHARS;
}

export function liveSummaryLabel(counts: ActivityCounts): string {
  const parts = [formatDuration(counts.elapsedMs)];
  if (counts.turns > 0) parts.push(`${String(counts.turns)} turn${counts.turns === 1 ? '' : 's'}`);
  if (counts.toolCalls > 0) {
    parts.push(`${String(counts.toolCalls)} tool call${counts.toolCalls === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/**
 * The line under an open card with nothing in it.
 *
 * A running step with an empty feed has two causes that read the same and mean
 * opposite things: the agent has not spoken, or this tab is not listening.
 * Saying "has not reported yet" on a dropped connection is the reading that was
 * wrong for fifteen seconds at a time after every server restart.
 */
export function emptyFeedLine(running: boolean, live: boolean): string {
  if (!running) return 'No activity was recorded for this run.';
  return live ? 'The coding agent has not reported yet.' : 'Waiting for the connection.';
}

/** The stored feed, read back from its payload. Anything else reads as no feed. */
export function parseActivityFeed(data: unknown): HarnessActivityLine[] {
  if (!Array.isArray(data)) return [];
  const lines: HarnessActivityLine[] = [];
  for (const entry of data) {
    const parsed = HarnessActivityLineSchema.safeParse(entry);
    if (parsed.success) lines.push(parsed.data);
  }
  return lines;
}

/** A line of the feed — close enough to the end that new lines should follow. */
const STICK_THRESHOLD_PX = 24;

export function isPinnedToBottom(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= STICK_THRESHOLD_PX;
}

// ---------------------------------------------------------------------------
// Reading a finished run
// ---------------------------------------------------------------------------

/** A step's output payload, once the step has one. */
export function useHarnessResult(outputRef: string | undefined): HostHarnessResult | undefined {
  const { apiUrl, headers } = useApi();
  const [result, setResult] = useState<HostHarnessResult | undefined>(undefined);

  useEffect(() => {
    if (outputRef === undefined) {
      setResult(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchPayload(apiUrl, headers, outputRef);
        if (!cancelled && isHostHarnessResult(data)) setResult(data);
      } catch {
        // The card falls back to its feed; a missing payload is not a failure
        // a reader can act on, and the step's own row already says how it ended.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, outputRef]);

  return result;
}

/**
 * The harness a step was given, read off the step's recorded input.
 *
 * Almost always free: a harness input is small enough to ride as an `inline:`
 * ref, which decodes without a request.
 */
export function useHarnessName(inputRef: string | undefined): string | undefined {
  const { apiUrl, headers } = useApi();
  const [name, setName] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (inputRef === undefined) {
      setName(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchPayload(apiUrl, headers, inputRef);
        if (!cancelled) setName(readHarnessId(data));
      } catch {
        // The card falls back to naming the lane; a title is not worth a
        // failure a reader can see.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, inputRef]);

  return name;
}

function useStoredFeed(
  activityRef: string | undefined,
  wanted: boolean,
): { lines: HarnessActivityLine[]; loading: boolean } {
  const { apiUrl, headers } = useApi();
  const [lines, setLines] = useState<HarnessActivityLine[]>(NO_LINES);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wanted || activityRef === undefined) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const data = await fetchPayload(apiUrl, headers, activityRef);
        if (!cancelled) setLines(parseActivityFeed(data));
      } catch {
        if (!cancelled) setLines(NO_LINES);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, activityRef, wanted]);

  return { lines, loading };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * One line of the feed.
 *
 * A call and its answer are each a row and no more: a screenful of one tool
 * result pushes the next twenty out of the box, and the reader was scanning for
 * what the agent did, not reading a file back. Narration wraps, because that is
 * the part written to be read.
 */
function ActivityLineRow({
  line,
  expanded,
  onToggle,
}: {
  line: HarnessActivityLine;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  if (line.kind === 'thought') {
    return <div className="harness-feed__line harness-feed__line--thought">{line.text}</div>;
  }
  if (line.kind === 'status') {
    return <div className="harness-feed__line harness-feed__line--status">{line.text}</div>;
  }

  const { tool, detail } = splitToolLine(line);
  const rowClass = `harness-feed__row${line.kind === 'tool_result' ? ' harness-feed__row--result' : ''}`;
  const body = (
    <>
      {line.kind === 'tool_result' ? (
        <Icon
          name={line.ok ? 'check' : 'warning-circle'}
          size="xs"
          color={line.ok ? 'var(--color-status-succeeded)' : 'var(--color-status-failed)'}
        />
      ) : (
        <span aria-hidden>›</span>
      )}
      <span className={`harness-feed__text${expanded ? ' harness-feed__text--open' : ''}`}>
        <span className="harness-feed__tool">{tool}</span>
        {detail !== '' && ` ${detail}`}
      </span>
    </>
  );

  if (!lineNeedsExpansion(line)) return <div className={rowClass}>{body}</div>;
  return (
    <button type="button" className={rowClass} aria-expanded={expanded} onClick={onToggle}>
      {body}
      <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
    </button>
  );
}

function ActivityFeed({
  lines,
  live,
  expandedLines,
  onToggleLine,
}: {
  lines: HarnessActivityLine[];
  live: boolean;
  expandedLines: ReadonlySet<number>;
  onToggleLine: (index: number) => void;
}): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !pinned) return;
    box.scrollTop = box.scrollHeight;
  }, [lines.length, pinned]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (box !== null) setPinned(isPinnedToBottom(box));
  }, []);

  const jump = useCallback(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.scrollTop = box.scrollHeight;
    setPinned(true);
  }, []);

  return (
    <div className="harness-feed__wrap">
      <div className="harness-feed" ref={boxRef} onScroll={onScroll}>
        {lines.map((line, index) => (
          <ActivityLineRow
            key={`${String(line.at)}-${String(index)}`}
            line={line}
            expanded={expandedLines.has(index)}
            onToggle={() => {
              onToggleLine(index);
            }}
          />
        ))}
      </div>
      {live && !pinned && (
        <button type="button" className="harness-feed__jump" onClick={jump}>
          jump to latest
        </button>
      )}
    </div>
  );
}

export interface HarnessActivityCardProps {
  /** The feed as the live channel has delivered it so far. */
  lines: HarnessActivityLine[];
  /** True while the step is still working. */
  running: boolean;
  /** The step's result, once it has one. */
  result?: HostHarnessResult | undefined;
  /** Where the whole feed is stored — read when the live lines are not held. */
  activityRef?: string | undefined;
  /** The harness and folder the step was given, when the host knows them. */
  harness?: string | undefined;
  folder?: string | undefined;
  /** Whose feed this is — the handle an expanded row is addressed against. */
  stepExecutionId?: string | undefined;
}

const NO_EXPANDED_LINES: ReadonlySet<number> = new Set<number>();

export function HarnessActivityCard({
  lines,
  running,
  result,
  activityRef,
  harness,
  folder,
  stepExecutionId,
}: HarnessActivityCardProps): ReactNode {
  // Open while it runs, folded once it is done: a running step is the only
  // thing on screen worth watching, and a finished one has a result to read.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? running;

  const storedRef = activityRef ?? result?.activityRef;
  const stored = useStoredFeed(storedRef, open && lines.length === 0);
  const shown = lines.length > 0 ? lines : stored.lines;
  const counts = activityCounts(shown);
  const live = useHarnessFeedsLive();

  const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(NO_EXPANDED_LINES);
  // A row is remembered by its position in one step's feed, so another step's
  // feed would open rows nobody asked for.
  useEffect(() => {
    setExpandedLines(NO_EXPANDED_LINES);
  }, [stepExecutionId]);
  const toggleLine = useCallback((index: number) => {
    setExpandedLines((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const { title, lane } = harnessCardTitle({
    reported: readResultHarness(result),
    harness,
    folder,
    continued: result?.continued,
  });

  const fold = (
    <>
      <button
        type="button"
        className="harness-activity__header"
        aria-expanded={open}
        onClick={() => {
          setOpenOverride(!open);
        }}
      >
        <Icon name={open ? 'caret-down' : 'caret-right'} size="xs" />
        <Text variant="mono" size="sm">
          {title}
        </Text>
        {lane !== undefined && (
          <Text variant="muted" size="xs">
            {lane}
          </Text>
        )}
        {running && (
          <>
            <Spinner size="sm" />
            <Badge variant="neutral">running</Badge>
          </>
        )}
        <Text variant="muted" size="xs">
          {running ? liveSummaryLabel(counts) : foldHeaderText(counts, storedRef !== undefined)}
        </Text>
      </button>

      {open && (
        <div className="harness-activity__body">
          {shown.length > 0 ? (
            <ActivityFeed
              lines={shown}
              live={running}
              expandedLines={expandedLines}
              onToggleLine={toggleLine}
            />
          ) : stored.loading ? (
            <Spinner size="sm" />
          ) : (
            <Text variant="muted" size="sm">
              {emptyFeedLine(running, live)}
            </Text>
          )}
        </div>
      )}
    </>
  );

  const leads = leadingSection({ running, hasResult: result !== undefined });
  const answer =
    result === undefined ? null : (
      <div
        className={`harness-activity__body${leads === 'result' ? ' harness-activity__body--lead' : ''}`}
      >
        <HostHarnessHeader result={result} harness={harness} />
        <div style={{ marginTop: 'var(--space-2)' }}>
          <HostHarnessBody result={result} />
        </div>
      </div>
    );

  return (
    <div className="harness-activity">
      {leads === 'result' ? (
        <>
          {answer}
          {fold}
        </>
      ) : (
        <>
          {fold}
          {answer}
        </>
      )}
    </div>
  );
}
