'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { Badge, CodeBlock, Icon, JsonViewer } from '@aflow/design-system';
import { MarkdownRenderer } from '../markdown-renderer.js';
import {
  parseCodingTranscript,
  type ToolResult,
  type TranscriptEntry,
} from './codingTranscript.js';

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_RAW_CHARS = 100_000;
/** The timeline scrolls within this height rather than growing the whole panel. */
const TIMELINE_MAX_HEIGHT = 480;

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 'var(--font-size-xs)',
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {children}
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '2px var(--space-2)',
        borderRadius: 'var(--radius-full)',
        border: '1px solid var(--color-border-subtle)',
        background: active ? 'var(--color-accent-bg)' : 'transparent',
        color: active ? 'var(--color-accent-text)' : 'var(--color-text-muted)',
        fontSize: 'var(--font-size-xs)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function MessageBlock({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  const isUser = role === 'user';
  return (
    <div
      style={{
        borderLeft: `2px solid ${
          isUser ? 'var(--color-accent-default)' : 'var(--color-border-default)'
        }`,
        paddingLeft: 'var(--space-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      <SectionLabel>{isUser ? 'Prompt' : 'Agent'}</SectionLabel>
      <div style={{ fontSize: 'var(--font-size-sm)' }}>
        <MarkdownRenderer content={text} />
      </div>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <div
      style={{
        borderLeft: '2px solid var(--color-border-subtle)',
        paddingLeft: 'var(--space-2)',
        fontSize: 'var(--font-size-xs)',
        fontStyle: 'italic',
        color: 'var(--color-text-muted)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  );
}

function commandOf(input: unknown): string | undefined {
  if (typeof input === 'object' && input !== null && 'command' in input) {
    const command = (input as { command: unknown }).command;
    return typeof command === 'string' ? command : undefined;
  }
  return undefined;
}

function ToolOutput({ result }: { result: ToolResult }) {
  const truncated = result.text.length > MAX_TOOL_OUTPUT_CHARS;
  const shown = truncated ? result.text.slice(0, MAX_TOOL_OUTPUT_CHARS) : result.text;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <SectionLabel>{result.isError ? 'Error output' : 'Output'}</SectionLabel>
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-2)',
          borderRadius: 'var(--radius-md)',
          background: result.isError ? 'var(--color-danger-bg)' : 'var(--color-surface-2)',
          color: result.isError ? 'var(--color-danger-text)' : 'var(--color-text-secondary)',
          fontSize: 'var(--font-size-xs)',
          fontFamily: 'var(--font-family-mono)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 240,
          overflowY: 'auto',
        }}
      >
        {shown.length > 0 ? shown : '(no output)'}
      </pre>
      {truncated && (
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            fontStyle: 'italic',
            color: 'var(--color-text-muted)',
          }}
        >
          showing the first {MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')} of{' '}
          {result.text.length.toLocaleString('en-US')} characters
        </div>
      )}
    </div>
  );
}

function ToolRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const command = commandOf(entry.input);
  const isError = entry.result?.isError === true;
  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-1)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          width: '100%',
          padding: 'var(--space-1) var(--space-2)',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Icon name={open ? 'caret-down' : 'caret-right'} size="xs" />
        <Badge variant={isError ? 'danger' : 'neutral'}>{entry.name}</Badge>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-family-mono)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.summary}
        </span>
        {isError && <Badge variant="danger">error</Badge>}
      </button>
      {open && (
        <div
          style={{
            padding: 'var(--space-2)',
            borderTop: '1px solid var(--color-border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {command !== undefined ? (
            <CodeBlock language="bash" maxHeight="200px">
              {command}
            </CodeBlock>
          ) : (
            <JsonViewer data={entry.input} collapseDepth={1} maxHeight="200px" />
          )}
          {entry.result !== undefined && <ToolOutput result={entry.result} />}
        </div>
      )}
    </div>
  );
}

function ResultBlock({ entry }: { entry: Extract<TranscriptEntry, { kind: 'result' }> }) {
  const meta: string[] = [];
  if (entry.numTurns !== undefined) meta.push(`${entry.numTurns} turns`);
  if (entry.durationMs !== undefined) meta.push(`${(entry.durationMs / 1000).toFixed(1)}s`);
  if (entry.costUsd !== undefined) meta.push(`$${entry.costUsd.toFixed(2)}`);
  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        borderLeft: `2px solid ${
          entry.isError ? 'var(--color-danger-default)' : 'var(--color-success-default)'
        }`,
        background: 'var(--color-surface-1)',
        padding: 'var(--space-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      <SectionLabel>{entry.isError ? 'Result · failed' : 'Result'}</SectionLabel>
      {entry.text.length > 0 && (
        <div style={{ fontSize: 'var(--font-size-sm)' }}>
          <MarkdownRenderer content={entry.text} />
        </div>
      )}
      {meta.length > 0 && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
          {meta.join(' · ')}
        </div>
      )}
    </div>
  );
}

function EntryRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
      return <MessageBlock role={entry.kind} text={entry.text} />;
    case 'thinking':
      return <ThinkingBlock text={entry.text} />;
    case 'tool':
      return <ToolRow entry={entry} />;
    case 'result':
      return <ResultBlock entry={entry} />;
  }
}

function RawTranscript({ text }: { text: string }) {
  const truncated = text.length > MAX_RAW_CHARS;
  const shown = truncated ? text.slice(text.length - MAX_RAW_CHARS) : text;
  return (
    <div>
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-2)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface-1)',
          fontSize: 'var(--font-size-xs)',
          fontFamily: 'var(--font-family-mono)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 360,
          overflowY: 'auto',
        }}
      >
        {shown}
      </pre>
      {truncated && (
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--font-size-xs)',
            fontStyle: 'italic',
            color: 'var(--color-text-muted)',
          }}
        >
          showing the last {MAX_RAW_CHARS.toLocaleString('en-US')} of{' '}
          {text.length.toLocaleString('en-US')} characters
        </div>
      )}
    </div>
  );
}

/**
 * Renders a coding-agent session transcript as a readable timeline — prompt,
 * agent messages, tool calls (each paired with its result), and the final
 * result. Reasoning and the raw JSONL are available behind toggles.
 */
export function CodingTranscriptView({ transcript }: { transcript: string }) {
  const { entries, thinkingCount, skippedLines } = useMemo(
    () => parseCodingTranscript(transcript),
    [transcript],
  );
  const [showThinking, setShowThinking] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // Nothing distilled (unknown harness format) — fall back to the raw stream.
  if (entries.length === 0) {
    return <RawTranscript text={transcript} />;
  }

  const toolCount = entries.filter((e) => e.kind === 'tool').length;
  const messageCount = entries.filter((e) => e.kind === 'assistant').length;
  const visible = showThinking ? entries : entries.filter((e) => e.kind !== 'thinking');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
        }}
      >
        <span>
          {messageCount} {messageCount === 1 ? 'message' : 'messages'} · {toolCount}{' '}
          {toolCount === 1 ? 'tool call' : 'tool calls'}
        </span>
        <div style={{ flex: 1 }} />
        {thinkingCount > 0 && (
          <ToggleChip
            active={showThinking}
            onClick={() => {
              setShowThinking((v) => !v);
            }}
          >
            <Icon name="eye-slash" size="xs" />
            {showThinking ? 'Hide' : 'Show'} reasoning ({thinkingCount})
          </ToggleChip>
        )}
        <ToggleChip
          active={showRaw}
          onClick={() => {
            setShowRaw((v) => !v);
          }}
        >
          Raw
        </ToggleChip>
      </div>

      {showRaw ? (
        <RawTranscript text={transcript} />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            maxHeight: TIMELINE_MAX_HEIGHT,
            overflowY: 'auto',
            paddingRight: 'var(--space-1)',
          }}
        >
          {visible.map((entry, i) => (
            // flexShrink:0 — without it a column flex container shrinks items to
            // fit maxHeight, collapsing rows into lines instead of scrolling.
            <div key={i} style={{ flexShrink: 0 }}>
              <EntryRow entry={entry} />
            </div>
          ))}
        </div>
      )}

      {skippedLines > 0 && (
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            fontStyle: 'italic',
            color: 'var(--color-text-muted)',
          }}
        >
          {skippedLines.toLocaleString('en-US')} unparseable {skippedLines === 1 ? 'line' : 'lines'}{' '}
          skipped
        </div>
      )}
    </div>
  );
}
