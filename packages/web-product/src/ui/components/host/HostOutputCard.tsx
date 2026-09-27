'use client';

/**
 * What the operator's own computer said, made to look like it.
 *
 * A host run used to arrive as prose in the same column as everything else:
 * the agent's words, terminal output, a patch and a tool result, told apart by
 * reading them. The rule here is one sentence — anything the operator's machine
 * produced should look like their machine, and anything the agent says should
 * look like speech — which keeps the agent's voice as the plain default rather
 * than one card among many.
 *
 * Deliberately beside `ComputeResultCard` rather than replacing it: a sandboxed
 * command and a host command are the same idea run in different places, so they
 * share a block and should read the same.
 */

import { useState } from 'react';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  Icon,
  Inline,
  JsonViewer,
  Stack,
  Text,
} from '@aflow/design-system';

import { OutputSection } from '../output/OutputSection.js';
import { MarkdownRenderer } from '../markdown-renderer.js';
import { harnessCardTitle, readResultHarness } from '../../lib/harness-title.js';

/** `host.process.exec`. */
interface HostProcessResult {
  processId: string;
  bindingId?: string;
  command?: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  truncated: boolean;
  boundaryNote?: string;
}

/** `host.harness.run`. */
export interface HostHarnessResult {
  runId: string;
  sessionRef?: string;
  continued?: boolean;
  /** The harness that ran, as the machine's own profile names it. */
  harness?: { id: string; label?: string };
  baseSha: string;
  /** What the harness reported, validated against the task's `outputSchema`. */
  result?: unknown;
  /** The run's activity feed, stored once at completion. */
  activityRef?: string;
  patch?: string;
  filesChanged: number;
  patchTruncated?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  applies?: string;
  headMoved?: boolean;
  blockedDomains?: string[];
  boundaryNote?: string;
}

export function isHostProcessResult(data: unknown): data is HostProcessResult {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  // `processId` is the discriminator: a compute result carries `data` and no
  // handle, so the two cannot be confused by shape.
  return typeof o['processId'] === 'string' && 'durationMs' in o && 'truncated' in o;
}

/**
 * `host.process.inspect` — what a detached process has said since last read.
 *
 * A separate shape, not a variant of the exec result: inspect reports a state
 * and a slice of output, and carries neither a duration nor an exit for a
 * process still running. Sharing a guard meant the stricter exec fields
 * excluded it, and the follow-up output of exactly the long-running commands
 * this card exists for fell back to raw JSON.
 */
interface HostInspectResult {
  processId: string;
  state: 'running' | 'exited' | 'unknown';
  startedAt?: string;
  exitCode?: number | null;
  descendantCount?: number;
  output?: string;
  truncated?: boolean;
}

export function isHostInspectResult(data: unknown): data is HostInspectResult {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return (
    typeof o['processId'] === 'string' &&
    (o['state'] === 'running' || o['state'] === 'exited' || o['state'] === 'unknown')
  );
}

export function HostInspectCard({ result }: { result: HostInspectResult }): React.ReactNode {
  const said = result.output ?? '';
  return (
    <Card>
      <CardHeader>
        <Inline gap="sm" align="center">
          <Text variant="mono" size="sm">
            {result.processId}
          </Text>
          {result.state === 'running' ? (
            <Badge variant="neutral">running</Badge>
          ) : result.state === 'exited' ? (
            <ExitBadge exitCode={result.exitCode ?? null} timedOut={false} />
          ) : (
            <Badge variant="warning">not known here</Badge>
          )}
          {result.descendantCount !== undefined && result.descendantCount > 0 && (
            <Text variant="muted" size="xs">
              {`${String(result.descendantCount)} child${result.descendantCount === 1 ? '' : 'ren'}`}
            </Text>
          )}
          {result.truncated === true && <Badge variant="warning">output dropped</Badge>}
        </Inline>
      </CardHeader>
      <CardBody>
        <Stack gap="sm">
          {said.trim() !== '' ? (
            <OutputSection label="since last read" content={said} />
          ) : (
            <Text variant="muted" size="sm">
              {result.state === 'running' ? 'Nothing new since last read.' : 'Said nothing.'}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

export function isHostHarnessResult(data: unknown): data is HostHarnessResult {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return typeof o['runId'] === 'string' && typeof o['baseSha'] === 'string';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Zero is quiet; anything else is the thing worth seeing first. */
export function ExitBadge({
  exitCode,
  timedOut,
}: {
  exitCode: number | null;
  timedOut: boolean;
}): React.ReactNode {
  if (timedOut) return <Badge variant="warning">timed out</Badge>;
  if (exitCode === null) return <Badge variant="neutral">running</Badge>;
  if (exitCode === 0) return <Badge variant="neutral">exit 0</Badge>;
  return <Badge variant="danger">{`exit ${String(exitCode)}`}</Badge>;
}

export function HostProcessCard({ result }: { result: HostProcessResult }): React.ReactNode {
  return (
    <Card>
      <CardHeader>
        <Inline gap="sm" align="center">
          {/* The command, not the handle. `hp_1789296647669_3` identifies the
              process and describes nothing; a reader scanning a transcript is
              looking for which folder and what ran. The handle stays reachable
              as the title for anyone who needs it for inspect or stop. */}
          <Text variant="mono" size="sm" title={result.processId}>
            {result.bindingId !== undefined && result.command !== undefined
              ? `${result.bindingId} · ${result.command}`
              : result.processId}
          </Text>
          <ExitBadge exitCode={result.exitCode} timedOut={result.timedOut} />
          <Text variant="muted" size="xs">
            {formatDuration(result.durationMs)}
          </Text>
          {result.truncated && <Badge variant="warning">output capped</Badge>}
        </Inline>
      </CardHeader>
      <CardBody>
        <Stack gap="sm">
          {result.boundaryNote !== undefined && <Text size="sm">{result.boundaryNote}</Text>}
          {result.stdout !== undefined && result.stdout.trim() !== '' && (
            <OutputSection label="stdout" content={result.stdout} />
          )}
          {result.stderr !== undefined && result.stderr.trim() !== '' && (
            <OutputSection label="stderr" content={result.stderr} variant="danger" />
          )}
          {(result.stdout ?? '').trim() === '' && (result.stderr ?? '').trim() === '' && (
            <Text variant="muted" size="sm">
              No output.
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * A check the harness reported inside its typed result.
 *
 * Read by shape rather than from a schema: the result is whatever the task's
 * `outputSchema` asked for, so a build or test verdict arrives under whichever
 * spelling the skill chose. An entry nothing can be read from is skipped, which
 * leaves the whole result below to answer for it.
 */
export interface HarnessCheck {
  label: string;
  ok: boolean | null;
}

const CHECK_LABEL_FIELDS = ['name', 'label', 'profileName', 'command', 'failedCommand', 'id'];
const CHECK_PASSED = new Set(['success', 'passed', 'pass', 'ok', 'succeeded']);
const CHECK_FAILED = new Set(['failure', 'failed', 'fail', 'error', 'errored']);

export function readHarnessChecks(value: unknown): HarnessCheck[] {
  if (value === null || typeof value !== 'object') return [];
  const raw = (value as Record<string, unknown>)['checks'];
  if (!Array.isArray(raw)) return [];
  const checks: HarnessCheck[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const field = CHECK_LABEL_FIELDS.find((name) => typeof record[name] === 'string');
    if (field === undefined) continue;
    checks.push({ label: record[field] as string, ok: readCheckOutcome(record) });
  }
  return checks;
}

function readCheckOutcome(record: Record<string, unknown>): boolean | null {
  for (const name of ['ok', 'passed', 'success']) {
    const value = record[name];
    if (typeof value === 'boolean') return value;
  }
  for (const name of ['conclusion', 'status', 'outcome', 'result']) {
    const value = record[name];
    if (typeof value !== 'string') continue;
    const normalized = value.toLowerCase();
    if (CHECK_PASSED.has(normalized)) return true;
    if (CHECK_FAILED.has(normalized)) return false;
  }
  return null;
}

/** The paths a unified diff touches, in the order the diff names them. */
export function changedFilePaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match === null) continue;
    const path = match[2] ?? match[1];
    if (path !== undefined && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function ChecksStrip({ checks }: { checks: HarnessCheck[] }): React.ReactNode {
  return (
    <Stack gap="xs">
      <Text variant="label" size="xs">
        checks
      </Text>
      <Inline gap="sm" align="center" wrap>
        {checks.map((check) => (
          <Inline key={check.label} gap="xs" align="center">
            <Icon
              name={check.ok === false ? 'warning-circle' : 'check'}
              size="xs"
              color={
                check.ok === true
                  ? 'var(--color-status-succeeded)'
                  : check.ok === false
                    ? 'var(--color-status-failed)'
                    : 'var(--color-text-muted)'
              }
            />
            <Text variant="mono" size="xs">
              {check.label}
            </Text>
          </Inline>
        ))}
      </Inline>
    </Stack>
  );
}

/**
 * What changed, as files first and the diff on request.
 *
 * A harness run over a folder answers "which files" far more often than "which
 * lines", and a screenful of diff in a chat buries whatever followed it.
 */
function ChangedFiles({ patch, baseSha }: { patch: string; baseSha: string }): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  const files = changedFilePaths(patch);

  return (
    <Stack gap="xs">
      <button
        type="button"
        onClick={() => {
          setExpanded((open) => !open);
        }}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
        }}
      >
        <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
        <Text variant="label" size="xs">
          changes
        </Text>
        <Text variant="muted" size="xs">
          {`diff against ${baseSha.slice(0, 9)}`}
        </Text>
      </button>
      {files.length > 0 && (
        <Stack gap="none">
          {files.map((file) => (
            <Text key={file} variant="mono" size="xs">
              {file}
            </Text>
          ))}
        </Stack>
      )}
      {expanded && (
        <CodeBlock language="diff" copyable>
          {patch}
        </CodeBlock>
      )}
    </Stack>
  );
}

/**
 * Everything a finished harness run has to say, in one block.
 *
 * Shared rather than duplicated: the same content is the result card in the
 * conversation and the completed half of the step's activity card, and two
 * renderings of one result drift into two different answers to the same
 * question.
 */
export function HostHarnessBody({ result }: { result: HostHarnessResult }): React.ReactNode {
  const blocked = result.blockedDomains ?? [];
  const checks = readHarnessChecks(result.result);

  return (
    <Stack gap="sm">
      {blocked.length > 0 && (
        <Text size="sm">
          {`The boundary refused ${blocked.join(', ')}, so anything needing it did not happen.`}
        </Text>
      )}
      {result.boundaryNote !== undefined && <Text size="sm">{result.boundaryNote}</Text>}
      {/* The closing answer is prose the agent wrote for a reader — headings,
          lists, a fenced diff — and a code block renders all of it as source. */}
      {result.stdout !== undefined && result.stdout.trim() !== '' && (
        <Stack gap="xs">
          <Text variant="label" size="xs">
            what it said
          </Text>
          <MarkdownRenderer content={result.stdout} />
        </Stack>
      )}
      {result.result !== undefined && result.result !== null && (
        <Stack gap="xs">
          <Text variant="label" size="xs">
            result
          </Text>
          <JsonViewer data={result.result} collapseDepth={2} maxHeight="240px" />
        </Stack>
      )}
      {checks.length > 0 && <ChecksStrip checks={checks} />}
      {result.patch !== undefined && result.patch.trim() !== '' && (
        <ChangedFiles patch={result.patch} baseSha={result.baseSha} />
      )}
      {/* A harness that fails often says why on stderr alone, and without this
          the card is a red exit code and no explanation. */}
      {result.stderr !== undefined && result.stderr.trim() !== '' && (
        <OutputSection label="diagnostics" content={result.stderr} variant="danger" />
      )}
    </Stack>
  );
}

/** The header line of a harness run — what ran, how it ended, how much moved. */
export function HostHarnessHeader({
  result,
  harness,
}: {
  result: HostHarnessResult;
  /** The harness id the step was given, where the surface could read it. */
  harness?: string | undefined;
}): React.ReactNode {
  const { title, lane } = harnessCardTitle({
    reported: readResultHarness(result),
    harness,
    continued: result.continued,
  });
  return (
    <Inline gap="sm" align="center">
      <Text variant="mono" size="sm">
        {title}
      </Text>
      {lane !== undefined && (
        <Text variant="muted" size="xs">
          {lane}
        </Text>
      )}
      <ExitBadge exitCode={result.exitCode} timedOut={result.timedOut} />
      <Text variant="muted" size="xs">
        {`${String(result.filesChanged)} file${result.filesChanged === 1 ? '' : 's'} · ${formatDuration(result.durationMs)}`}
      </Text>
      {/* Whether the diff still fits the repository is the first thing a reader
          needs, since it decides whether the patch can be taken. */}
      {result.applies === 'conflict' && <Badge variant="danger">does not apply</Badge>}
      {result.headMoved === true && <Badge variant="warning">head moved</Badge>}
      {result.patchTruncated === true && <Badge variant="warning">patch capped</Badge>}
    </Inline>
  );
}
