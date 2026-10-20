'use client';

/**
 * A harness step, while it works and once it is done.
 *
 * A harness runs for minutes and says nothing until the end, so the wait is
 * the whole of the experience. What a person watching needs from it is proof
 * of life: what the agent says it is doing, or the last thing it wrote, and how
 * long ago it last did anything; then the files it is changing. The tool calls
 * are the record of how, folded behind a disclosure — a scroll of invocations
 * cannot be read in real time. This is that wait, under the step rather than
 * inside the agent's message — an executor's view of its own work is not the
 * run speaking.
 *
 * One component, every place: the chat, the step row in the timeline and the
 * task row in a run all mount `HarnessStepCard`. They show the same thing,
 * because they are the same thing.
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
  type CSSProperties,
  type ReactNode,
} from 'react';
import { HarnessActivityLineSchema, type HarnessActivityLine } from '@aflow/schemas';
import type { HarnessActivityState } from '@aflow/run-view';
import { Badge, Icon, Spinner, Text } from '@aflow/design-system';

import { fetchPayload } from '../lib/fetch-payload.js';
import { harnessCardTitle, readHarnessId, readResultHarness } from '../lib/harness-title.js';
import { useApi } from './providers.js';
import { useNowTicker } from './workflow-run-surface/useNowTicker.js';
import {
  HostHarnessBody,
  HostHarnessHeader,
  formatDuration,
  isHostHarnessResult,
  type HostHarnessResult,
} from './host/HostOutputCard.js';
import './harness-activity-card.css';

export const HARNESS_RUN_OPERATION = 'host.harness.run';

/** Host steps whose live output folds under them as `output` lines. */
export const COMMAND_OUTPUT_OPERATIONS: ReadonlySet<string> = new Set([
  'host.commit.check',
  'host.process.exec',
]);

const COMMAND_OUTPUT_TITLE = { title: 'Command output', lane: undefined } as const;

/** A feed of what a command printed, rather than a coding agent's account of its work. */
export function isCommandOutput(lines: readonly HarnessActivityLine[]): boolean {
  return lines.length > 0 && lines.every((line) => line.kind === 'output');
}

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

/** One step's feed as the surface's provider holds it, when it holds one. */
export function useHarnessActivityFeed(
  stepExecutionId: string | undefined,
): HarnessActivityState | undefined {
  const { feeds } = useContext(HarnessActivityContext);
  return stepExecutionId === undefined ? undefined : feeds[stepExecutionId];
}

/**
 * The card for one step, reading that step's feed from the surface's provider.
 *
 * The only way a surface mounts the card: the chat renders it while the step
 * runs and again on the step's result, the run timeline under a step row, and a
 * run's view under its task — so a commission watched from its run reads the
 * same card as a call watched from the chat, from the same feed.
 */
export function HarnessStepCard({
  stepExecutionId,
  running,
  result,
  harness,
  startedAt,
}: {
  stepExecutionId: string | undefined;
  running: boolean;
  result?: HostHarnessResult | undefined;
  harness?: string | undefined;
  /** When the step started, where the surface knows it — the elapsed clock. */
  startedAt?: string | number | undefined;
}): ReactNode {
  const feed = useHarnessActivityFeed(stepExecutionId);
  const startedAtMs =
    typeof startedAt === 'number'
      ? startedAt
      : startedAt === undefined
        ? Number.NaN
        : Date.parse(startedAt);
  return (
    <HarnessActivityCard
      lines={feed?.lines ?? NO_LINES}
      running={running}
      result={result}
      harness={harness}
      stepExecutionId={stepExecutionId}
      {...(feed !== undefined && feed.lastActivityAtMs > 0
        ? { lastActivityAtMs: feed.lastActivityAtMs }
        : {})}
      {...(Number.isNaN(startedAtMs) ? {} : { startedAtMs })}
    />
  );
}

/**
 * What a command step printed while it ran, under its row.
 *
 * Only from the live feed: what it printed is stored as the step's own output
 * — a check's logs, a command's stdout — so with no live lines held, a card
 * would only say there is nothing here.
 */
export function CommandOutputStepCard({
  stepExecutionId,
  running,
  startedAt,
  style,
}: {
  stepExecutionId: string | undefined;
  running: boolean;
  startedAt?: string | number | undefined;
  /** The row's spacing, which an absent card must not leave behind. */
  style?: CSSProperties | undefined;
}): ReactNode {
  const feed = useHarnessActivityFeed(stepExecutionId);
  if (feed === undefined || feed.lines.length === 0) return null;
  return (
    <div style={style}>
      <HarnessStepCard stepExecutionId={stepExecutionId} running={running} startedAt={startedAt} />
    </div>
  );
}

/** Every feed this surface holds — for a row that reads many at once. */
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

/**
 * The line the card leads with: the last thing the agent said — what it says it
 * is doing, or what it wrote in plain text — or the last line a command
 * printed, or, before any of those, the last fact the run reported about itself.
 *
 * A tool call never leads. A scroll of invocations is the record of the work,
 * not an account of it, and is what a person watching cannot read in real time.
 */
export function leadLine(lines: readonly HarnessActivityLine[]): HarnessActivityLine | undefined {
  let status: HarnessActivityLine | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.kind === 'intent' || line.kind === 'thought' || line.kind === 'output') return line;
    if (line.kind === 'status' && status === undefined) status = line;
  }
  return status;
}

/** The files the run has changed, the most recently touched first. */
export function changedFiles(lines: readonly HarnessActivityLine[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.kind !== 'tool' || line.changes === undefined || seen.has(line.changes)) continue;
    seen.add(line.changes);
    files.push(line.changes);
  }
  return files;
}

/** The last call the run made — what the folded tool lines say they end on. */
export function lastToolLine(
  lines: readonly HarnessActivityLine[],
): Extract<HarnessActivityLine, { kind: 'tool' }> | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.kind === 'tool') return line;
  }
  return undefined;
}

/**
 * How a call's result is marked.
 *
 * A command's exit status is not yet one a reader can trust (Plan 315 F84):
 * inside a commission a command that succeeded can still exit non-zero on a
 * sandbox refusal, so every check the agent ran would read as a failure. Until
 * the lane makes that status true, a command's result is shown without a
 * verdict. Every other tool's error is its own report, and is shown as one.
 */
export function resultMark(
  line: Extract<HarnessActivityLine, { kind: 'tool_result' }>,
): 'ok' | 'failed' | 'unjudged' {
  if (line.command === true) return 'unjudged';
  return line.ok ? 'ok' : 'failed';
}

/**
 * How long the run has been going, as of `nowMs`.
 *
 * From the step's start where the surface knows it. Otherwise from the feed:
 * the last line's offset, plus the wall-clock time since that line arrived — so
 * a run that has been quiet for a minute does not read as a minute younger.
 */
export function runElapsedMs(opts: {
  counts: ActivityCounts;
  nowMs: number;
  startedAtMs?: number | undefined;
  lastActivityAtMs?: number | undefined;
}): number {
  if (opts.startedAtMs !== undefined) return Math.max(0, opts.nowMs - opts.startedAtMs);
  if (opts.lastActivityAtMs === undefined) return opts.counts.elapsedMs;
  return opts.counts.elapsedMs + Math.max(0, opts.nowMs - opts.lastActivityAtMs);
}

/** The time since the harness last wrote anything — the card's proof of life. */
export function sinceActivityLabel(nowMs: number, lastActivityAtMs: number): string {
  const ms = Math.max(0, nowMs - lastActivityAtMs);
  if (ms < 2_000) return 'active now';
  return `last active ${formatDuration(ms)} ago`;
}

export function liveSummaryLabel(
  counts: ActivityCounts,
  elapsedMs: number = counts.elapsedMs,
): string {
  const parts = [formatDuration(elapsedMs)];
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
  if (line.kind === 'thought' || line.kind === 'intent') {
    return <div className="harness-feed__line harness-feed__line--thought">{line.text}</div>;
  }
  if (line.kind === 'status') {
    return <div className="harness-feed__line harness-feed__line--status">{line.text}</div>;
  }
  if (line.kind === 'output') {
    return <div className="harness-feed__line">{line.text}</div>;
  }

  const { tool, detail } = splitToolLine(line);
  const rowClass = `harness-feed__row${line.kind === 'tool_result' ? ' harness-feed__row--result' : ''}`;
  const mark = line.kind === 'tool_result' ? resultMark(line) : null;
  const body = (
    <>
      {mark === 'ok' || mark === 'failed' ? (
        <Icon
          name={mark === 'ok' ? 'check' : 'warning-circle'}
          size="xs"
          color={mark === 'ok' ? 'var(--color-status-succeeded)' : 'var(--color-status-failed)'}
        />
      ) : (
        <span aria-hidden>{mark === 'unjudged' ? '↳' : '›'}</span>
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
  /** When the harness last wrote anything, by this tab's clock. Live feeds only. */
  lastActivityAtMs?: number | undefined;
  /** When the step started, where the surface knows it. */
  startedAtMs?: number | undefined;
}

const NO_EXPANDED_LINES: ReadonlySet<number> = new Set<number>();

/** At most this many changed files are named before the rest are counted. */
const FILES_SHOWN = 6;

function ChangedFilesLine({ files }: { files: string[] }): ReactNode {
  const shown = files.slice(0, FILES_SHOWN);
  const more = files.length - shown.length;
  return (
    <div className="harness-activity__files">
      <Text variant="muted" size="xs">
        {`Changing ${String(files.length)} file${files.length === 1 ? '' : 's'}`}
      </Text>
      <ul className="harness-activity__file-list">
        {shown.map((file) => (
          <li key={file} className="harness-activity__file" title={file}>
            {file}
          </li>
        ))}
        {more > 0 && <li className="harness-activity__file-more">{`+${String(more)} more`}</li>}
      </ul>
    </div>
  );
}

/** The folded tool lines say how many there are and the call they end on. */
export function toolDisclosureLabel(lines: readonly HarnessActivityLine[]): string {
  const counts = activityCounts([...lines]);
  const head =
    counts.toolCalls > 0
      ? `${String(counts.toolCalls)} tool call${counts.toolCalls === 1 ? '' : 's'}`
      : `${String(counts.events)} event${counts.events === 1 ? '' : 's'}`;
  const last = lastToolLine(lines);
  return last === undefined ? head : `${head} · last: ${last.text}`;
}

export function HarnessActivityCard({
  lines,
  running,
  result,
  activityRef,
  harness,
  folder,
  stepExecutionId,
  lastActivityAtMs,
  startedAtMs,
}: HarnessActivityCardProps): ReactNode {
  // Open while it runs, folded once it is done: a running step is the only
  // thing on screen worth watching, and a finished one has a result to read.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? running;
  // The tool lines stay folded whether or not the run is: the lead line and
  // the files are what a person watching reads, and the calls are for the one
  // who goes looking.
  const [toolsOpen, setToolsOpen] = useState(false);

  const storedRef = activityRef ?? result?.activityRef;
  const stored = useStoredFeed(storedRef, open && lines.length === 0);
  const shown = lines.length > 0 ? lines : stored.lines;
  const counts = activityCounts(shown);
  const live = useHarnessFeedsLive();
  const nowMs = useNowTicker(running);
  const lead = leadLine(shown);
  const files = changedFiles(shown);
  const elapsedMs = runElapsedMs({ counts, nowMs, startedAtMs, lastActivityAtMs });

  const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(NO_EXPANDED_LINES);
  // A row is remembered by its position in one step's feed, so another step's
  // feed would open rows nobody asked for.
  useEffect(() => {
    setExpandedLines(NO_EXPANDED_LINES);
    setToolsOpen(false);
  }, [stepExecutionId]);
  const toggleLine = useCallback((index: number) => {
    setExpandedLines((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const { title, lane } = isCommandOutput(shown)
    ? COMMAND_OUTPUT_TITLE
    : harnessCardTitle({
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
          {running
            ? liveSummaryLabel(counts, elapsedMs)
            : foldHeaderText(counts, storedRef !== undefined)}
        </Text>
      </button>

      {open && (
        <div className="harness-activity__body">
          {shown.length > 0 ? (
            <>
              {(lead !== undefined || (running && lastActivityAtMs !== undefined)) && (
                <div className="harness-activity__lead" data-lead-kind={lead?.kind}>
                  {lead !== undefined && (
                    <div
                      className={`harness-activity__lead-text${lead.kind === 'status' ? ' harness-activity__lead-text--status' : ''}`}
                    >
                      {lead.text}
                    </div>
                  )}
                  {running && lastActivityAtMs !== undefined && (
                    <Text variant="muted" size="xs">
                      {sinceActivityLabel(nowMs, lastActivityAtMs)}
                    </Text>
                  )}
                </div>
              )}
              {files.length > 0 && <ChangedFilesLine files={files} />}
              <button
                type="button"
                className="harness-activity__tools"
                aria-expanded={toolsOpen}
                onClick={() => {
                  setToolsOpen(!toolsOpen);
                }}
              >
                <Icon name={toolsOpen ? 'caret-down' : 'caret-right'} size="xs" />
                <span className="harness-activity__tools-label">{toolDisclosureLabel(shown)}</span>
              </button>
              {toolsOpen && (
                <ActivityFeed
                  lines={shown}
                  live={running}
                  expandedLines={expandedLines}
                  onToggleLine={toggleLine}
                />
              )}
            </>
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
