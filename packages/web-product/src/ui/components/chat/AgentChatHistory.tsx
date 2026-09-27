'use client';

import { useState } from 'react';
import {
  Text,
  Column,
  Spinner,
  Badge,
  Row,
  JsonViewer,
  Icon,
  type IconName,
} from '@aflow/design-system';
import type { ToolSurface, ToolSurfaceEntry, TokenEstimate } from '@aflow/schemas';
import { bundleForOperation } from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { MarkdownRenderer } from '../markdown-renderer.js';
import {
  looksLikeMarkdown,
  splitTextAndJson,
  type ContentSegment,
} from '../../lib/content-detection.js';
import { AgentDecisionCard, extractAgentAction } from './AgentDecisionCard.js';

// ---------------------------------------------------------------------------
// Types matching AiMessageV1 from @aflow/schemas
// ---------------------------------------------------------------------------

interface AiContentPart {
  kind: 'text' | 'json' | 'ref';
  text?: string;
  json?: unknown;
  ref?: string;
  summary?: string;
}

interface AiToolCall {
  toolCallId: string;
  name: string;
  argumentsJson?: unknown;
}

interface AiMessage {
  role: string;
  toolCallId?: string;
  name?: string;
  parts?: AiContentPart[];
  toolCalls?: AiToolCall[];
}

interface AgentDecision {
  action: string;
  toolId?: string;
  args?: unknown;
  calls?: Array<{ toolId: string; args?: unknown }>;
  message?: string;
  result?: unknown;
  reasoning?: string;
}

interface ChatHistoryResponse {
  messages: AiMessage[];
  modelOutput?: string;
  decision?: AgentDecision;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  turnNumber?: number;
  contextWindow?: number | undefined;
  // Passthrough from the ai.agent.turn output payload (Plan 259). Optional so
  // a read of an older payload that predates them degrades gracefully.
  tokenEstimate?: TokenEstimate;
  toolSurface?: ToolSurface;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTextContent(msg: AiMessage): string {
  if (!msg.parts || !Array.isArray(msg.parts)) return '';
  return msg.parts
    .map((p) => {
      if (p.kind === 'text' && p.text) return p.text;
      if (p.kind === 'ref') return `[Ref: ${p.summary ?? p.ref ?? '…'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function getJsonParts(msg: AiMessage): unknown[] {
  if (!msg.parts || !Array.isArray(msg.parts)) return [];
  return msg.parts.filter((p) => p.kind === 'json' && p.json != null).map((p) => p.json);
}

/**
 * Build a proper AiMessage for the model's latest response.
 * When a structured decision is available, convert invoke_step/invoke_steps
 * into toolCalls so the ChatMessageRow renders them as rich cards.
 */
function buildResponseMessage(
  modelOutput: string | undefined,
  decision: AgentDecision | undefined,
): AiMessage {
  const parts: AiContentPart[] = [];
  const toolCalls: AiToolCall[] = [];

  // Extract text message from decision
  const decisionMessage = decision?.message;
  if (decisionMessage) {
    parts.push({ kind: 'text', text: decisionMessage });
  }

  if (decision) {
    if (decision.action === 'invoke_step' && decision.toolId) {
      toolCalls.push({
        toolCallId: decision.toolId,
        name: decision.toolId,
        argumentsJson: decision.args,
      });
    } else if (decision.action === 'invoke_steps' && decision.calls) {
      for (const call of decision.calls) {
        toolCalls.push({
          toolCallId: call.toolId,
          name: call.toolId,
          argumentsJson: call.args,
        });
      }
    } else if (decision.action === 'complete' && decision.result !== undefined) {
      parts.push({ kind: 'json', json: decision.result });
    } else if (decision.action === 'pause_for_input') {
      // message already added above
    }

    // If no text parts yet but we have modelOutput as fallback, use it only
    // when there are also no tool calls (otherwise the raw text is just the
    // stringified calls, which would be redundant).
    if (parts.length === 0 && toolCalls.length === 0 && modelOutput) {
      parts.push({ kind: 'text', text: modelOutput });
    }
  } else if (modelOutput) {
    // No decision available — fall back to raw text
    parts.push({ kind: 'text', text: modelOutput });
  }

  return {
    role: 'assistant',
    parts,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

interface RoleStyle {
  label: string;
  border: string;
  bg: string;
  icon: IconName;
}

const SYSTEM_ROLE_STYLE: RoleStyle = {
  label: 'System',
  border: 'var(--color-text-muted)',
  bg: 'color-mix(in srgb, var(--color-text-muted) 6%, transparent)',
  icon: 'gear',
};

const ROLE_STYLES: Record<string, RoleStyle> = {
  system: SYSTEM_ROLE_STYLE,
  user: {
    label: 'User',
    border: 'var(--color-text-muted)',
    bg: 'color-mix(in srgb, var(--color-accent-default) 8%, transparent)',
    icon: 'user-circle',
  },
  assistant: {
    label: 'Assistant',
    border: 'var(--color-text-muted)',
    bg: 'color-mix(in srgb, var(--color-text-muted) 6%, transparent)',
    icon: 'chat',
  },
  tool: {
    label: 'Tool',
    border: 'var(--color-status-paused)',
    bg: 'color-mix(in srgb, var(--color-status-paused) 8%, transparent)',
    icon: 'wrench',
  },
};

// ---------------------------------------------------------------------------
// Token estimation — proportionally scale char-based estimates to match actual
// ---------------------------------------------------------------------------

/** Rough char count for a message (text parts + JSON stringified tool calls). */
function estimateMessageChars(msg: AiMessage): number {
  let chars = 0;
  if (msg.parts) {
    for (const p of msg.parts) {
      if (p.kind === 'text' && p.text) chars += p.text.length;
      if (p.kind === 'json' && p.json) chars += JSON.stringify(p.json).length;
      if (p.kind === 'ref') chars += 60; // approximate ref overhead
    }
  }
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      chars += tc.name.length + 20; // name + overhead
      if (tc.argumentsJson) chars += JSON.stringify(tc.argumentsJson).length;
    }
  }
  // role + structural overhead
  chars += 12;
  return Math.max(chars, 4);
}

/**
 * Per-message token estimate — an INDEPENDENT char-based heuristic, deliberately
 * NOT rescaled to the provider's `promptTokens`. The prompt total also carries
 * system + tools cost (now shown separately in the usage bar), so scaling
 * messages up to absorb it would misattribute that cost to the conversation.
 */
function estimatePerMessageTokens(messages: AiMessage[]): number[] {
  return messages.map((m) => Math.round(estimateMessageChars(m) / 3.5));
}

// ---------------------------------------------------------------------------
// Token accounting bar — system / context / tools / history segments
// ---------------------------------------------------------------------------

const SEGMENTS: Array<{ key: keyof TokenEstimate; label: string; color: string }> = [
  { key: 'system', label: 'System', color: 'var(--color-text-muted)' },
  { key: 'context', label: 'Context', color: 'var(--color-accent-default)' },
  { key: 'tools', label: 'Tools', color: 'var(--color-status-paused)' },
  {
    key: 'history',
    label: 'History',
    color: 'color-mix(in srgb, var(--color-accent-default) 45%, var(--color-text-muted))',
  },
];

function TokenBar({
  tokenEstimate,
  promptTokens,
  contextWindow,
}: {
  tokenEstimate: TokenEstimate;
  promptTokens?: number | undefined;
  contextWindow?: number | undefined;
}) {
  const total = tokenEstimate.total || 1;
  const window = contextWindow ?? tokenEstimate.modelWindow;
  const windowPct = window > 0 ? (tokenEstimate.total / window) * 100 : 0;
  // Unattributed delta between the provider's actual prompt tokens and our
  // estimate — shown honestly rather than folded into a segment.
  const delta =
    promptTokens != null && promptTokens > 0 ? promptTokens - tokenEstimate.total : undefined;

  return (
    <div
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        backgroundColor: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      <Row gap="2" align="center" style={{ marginBottom: '5px' }}>
        <Text variant="mono" size="xs" style={{ fontSize: '10px', fontWeight: 600 }}>
          Context
        </Text>
        <Text variant="muted" size="xs" style={{ fontSize: '10px' }}>
          ~{formatNum(tokenEstimate.total)} / {formatNum(window)} est ({windowPct.toFixed(1)}%)
        </Text>
        <div style={{ flex: 1 }} />
        {promptTokens != null && promptTokens > 0 && (
          <Text variant="muted" size="xs" style={{ fontSize: '10px' }}>
            actual {formatNum(promptTokens)} in
          </Text>
        )}
      </Row>

      {/* Stacked segment bar */}
      <div
        style={{
          display: 'flex',
          height: '6px',
          borderRadius: '3px',
          overflow: 'hidden',
          backgroundColor: 'var(--color-border-subtle)',
        }}
      >
        {SEGMENTS.map((s) => {
          const val = tokenEstimate[s.key] ?? 0;
          const pct = (val / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={s.key}
              title={`${s.label}: ~${formatNum(val)} tokens`}
              style={{ width: `${pct}%`, backgroundColor: s.color, transition: 'width 0.3s ease' }}
            />
          );
        })}
      </div>

      {/* Legend */}
      <Row gap="2" align="center" style={{ marginTop: '5px', flexWrap: 'wrap' }}>
        {SEGMENTS.map((s) => {
          const val = tokenEstimate[s.key] ?? 0;
          return (
            <Row key={s.key} gap="1" align="center">
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '2px',
                  backgroundColor: s.color,
                  display: 'inline-block',
                }}
              />
              <Text variant="muted" size="xs" style={{ fontSize: '9px' }}>
                {s.label} {formatNum(val)}
              </Text>
            </Row>
          );
        })}
        {delta != null && delta !== 0 && (
          <Text
            variant="muted"
            size="xs"
            style={{ fontSize: '9px', fontStyle: 'italic', opacity: 0.8 }}
            title="Difference between the provider's actual prompt tokens and our heuristic estimate"
          >
            Δ {delta > 0 ? '+' : ''}
            {formatNum(delta)} unattributed
          </Text>
        )}
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool surface — what the agent could call this turn, grouped by source
// ---------------------------------------------------------------------------

const SOURCE_META: Record<string, { label: string; color: string }> = {
  core: { label: 'Core operations', color: 'var(--color-accent-default)' },
  graph: { label: 'Graph steps', color: 'var(--color-accent-default)' },
  api: { label: 'Integration endpoints', color: 'var(--color-status-paused)' },
  mcp: { label: 'MCP tools', color: 'var(--color-status-paused)' },
  discovered: { label: 'Promoted', color: 'var(--color-status-running)' },
  meta: { label: 'Control functions', color: 'var(--color-text-muted)' },
};

/**
 * Group the active surface by capability rather than by where a tool came
 * from. Source answers "how is this plumbed"; capability answers the question
 * an operator actually opens this panel with, and it is the same grouping the
 * composer control toggles, so what is read here is what gets switched there.
 *
 * Tools with no operation id — graph steps, the executor's own control
 * functions — have no capability group, so they keep a source-named group
 * rather than being dropped or forced into one they do not belong to.
 */
function groupSurfaceByCapability(
  entries: ToolSurfaceEntry[],
): Array<{ key: string; label: string; color: string; entries: ToolSurfaceEntry[] }> {
  const groups = new Map<string, { label: string; color: string; entries: ToolSurfaceEntry[] }>();
  for (const entry of entries) {
    const bundle = entry.operationId ? bundleForOperation(entry.operationId) : undefined;
    const key = bundle ? `bundle:${bundle.id}` : `source:${entry.source}`;
    const meta = SOURCE_META[entry.source] ?? {
      label: entry.source,
      color: 'var(--color-text-muted)',
    };
    const existing = groups.get(key);
    if (existing) existing.entries.push(entry);
    else
      groups.set(key, {
        label: bundle?.label ?? meta.label,
        color: bundle
          ? 'var(--color-accent-default)'
          : (SOURCE_META[entry.source]?.color ?? 'var(--color-text-muted)'),
        entries: [entry],
      });
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...g }))
    .sort((a, b) => {
      const at = a.entries.reduce((s, e) => s + e.estTokens, 0);
      const bt = b.entries.reduce((s, e) => s + e.estTokens, 0);
      return bt - at;
    });
}

/**
 * One capability group, collapsed by default. Collapsing is the point: a
 * two-dozen-tool surface listed flat is unreadable, and the counts plus token
 * cost on the header answer the common question without expanding anything.
 */
function ToolSurfaceGroup({
  label,
  color,
  count,
  tokens,
  entries,
}: {
  label: string;
  color: string;
  count: number;
  tokens: number;
  entries: ToolSurfaceEntry[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        // Not `all: unset` — that drops the focus ring and collapses the button
        // to `display: inline`, which makes `width: 100%` inert and strands the
        // count/token figure mid-row instead of right-aligning it.
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'block',
          width: '100%',
        }}
        aria-expanded={open}
      >
        <Row gap="1" align="center" style={{ marginBottom: '2px' }}>
          <Icon
            name={open ? 'caret-down' : 'caret-right'}
            size="xs"
            color="var(--color-text-muted)"
          />
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '2px',
              backgroundColor: color,
              display: 'inline-block',
            }}
          />
          <Text size="xs" style={{ fontSize: '9px', fontWeight: 600, textTransform: 'uppercase' }}>
            {label}
          </Text>
          <div style={{ flex: 1 }} />
          <Text
            variant="muted"
            size="xs"
            style={{ fontSize: '9px', fontVariantNumeric: 'tabular-nums' }}
          >
            {count} · ~{formatNum(tokens)} tok
          </Text>
        </Row>
      </button>
      {open && entries.map((e) => <ToolSurfaceRow key={e.toolId} entry={e} />)}
    </div>
  );
}

function ToolSurfaceRow({ entry }: { entry: ToolSurfaceEntry }) {
  const [open, setOpen] = useState(false);
  const hasSchema = entry.parameters && Object.keys(entry.parameters).length > 0;
  return (
    <div style={{ padding: '3px 0', borderTop: '1px solid var(--color-border-subtle)' }}>
      <Row gap="2" align="center">
        <Text variant="mono" size="xs" style={{ fontSize: '10px', wordBreak: 'break-all' }}>
          {entry.callName}
        </Text>
        {entry.discoveredAtTurn != null && (
          <Badge variant="neutral" style={{ fontSize: '8px' }}>
            promoted · turn {entry.discoveredAtTurn}
          </Badge>
        )}
        <div style={{ flex: 1 }} />
        <Text variant="muted" size="xs" style={{ fontSize: '9px', whiteSpace: 'nowrap' }}>
          ~{formatNum(entry.estTokens)} tok
        </Text>
        {hasSchema && (
          <button
            onClick={() => {
              setOpen((v) => !v);
            }}
            style={{
              all: 'unset',
              cursor: 'pointer',
              color: 'var(--color-text-link)',
              fontSize: '9px',
            }}
          >
            {open ? 'hide' : 'schema'}
          </button>
        )}
      </Row>
      {entry.description && (
        <Text variant="muted" size="xs" style={{ fontSize: '9px', opacity: 0.75 }}>
          {(entry.description.split('\n')[0] ?? '').slice(0, 120)}
        </Text>
      )}
      {open && hasSchema && (
        <div style={{ marginTop: '3px' }}>
          <JsonViewer data={entry.parameters} collapseDepth={2} maxHeight="220px" />
        </div>
      )}
    </div>
  );
}

function ToolSurfaceSection({ surface }: { surface: ToolSurface }) {
  const [open, setOpen] = useState(false);
  const totalTools = surface.active.reduce((s, e) => s + e.estTokens, 0);
  const groups = groupSurfaceByCapability(surface.active);

  return (
    <div
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      <button
        onClick={() => {
          setOpen((v) => !v);
        }}
        style={{ all: 'unset', cursor: 'pointer', width: '100%' }}
      >
        <Row gap="2" align="center">
          <Icon
            name={open ? 'caret-down' : 'caret-right'}
            size="xs"
            color="var(--color-text-muted)"
          />
          <Text size="xs" style={{ fontSize: '10px', fontWeight: 600 }}>
            Tools
          </Text>
          <Text variant="muted" size="xs" style={{ fontSize: '10px' }}>
            {surface.active.length} active · ~{formatNum(totalTools)} tok
          </Text>
          <div style={{ flex: 1 }} />
          <Badge variant="neutral" style={{ fontSize: '8px' }}>
            {surface.deliveryMode === 'native_fc' ? 'native FC' : 'JSON'}
          </Badge>
          {surface.scope && (
            <Text variant="muted" size="xs" style={{ fontSize: '9px', whiteSpace: 'nowrap' }}>
              {surface.scope.pinnedUsed}/{surface.scope.pinnedMax} pinned ·{' '}
              {surface.scope.virtualUsed}/{surface.scope.virtualMax} promoted
            </Text>
          )}
        </Row>
      </button>

      {open && (
        <Column gap="2" style={{ marginTop: 'var(--space-2)' }}>
          {groups.map((g) => {
            const groupTokens = g.entries.reduce((s, e) => s + e.estTokens, 0);
            return (
              <ToolSurfaceGroup
                key={g.key}
                label={g.label}
                color={g.color}
                count={g.entries.length}
                tokens={groupTokens}
                entries={g.entries}
              />
            );
          })}
        </Column>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discoverable — reachable via catalog.tool.search/promote, not yet callable
// ---------------------------------------------------------------------------

function DiscoverableSection({
  discoverable,
}: {
  discoverable: NonNullable<ToolSurface['discoverable']>;
}) {
  const [open, setOpen] = useState(false);
  const { operationIds, operationCount, apiBindingCount, mcpServerCount } = discoverable;
  if (operationCount === 0 && apiBindingCount === 0 && mcpServerCount === 0) return null;
  const hasIds = operationIds.length > 0;

  return (
    <div
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--color-border-subtle)',
      }}
    >
      <button
        onClick={() => {
          if (hasIds) setOpen((v) => !v);
        }}
        style={{ all: 'unset', cursor: hasIds ? 'pointer' : 'default', width: '100%' }}
      >
        <Row gap="2" align="center">
          {hasIds && (
            <Icon
              name={open ? 'caret-down' : 'caret-right'}
              size="xs"
              color="var(--color-text-muted)"
            />
          )}
          <Text size="xs" style={{ fontSize: '10px', fontWeight: 600 }}>
            Discoverable
          </Text>
          <Text variant="muted" size="xs" style={{ fontSize: '9px' }}>
            not yet callable
          </Text>
          <div style={{ flex: 1 }} />
          <Text variant="muted" size="xs" style={{ fontSize: '9px', whiteSpace: 'nowrap' }}>
            {operationCount} ops · {apiBindingCount} API · {mcpServerCount} MCP
          </Text>
        </Row>
      </button>
      {open && hasIds && (
        <Column gap="1" style={{ marginTop: 'var(--space-1)' }}>
          {operationIds.map((id) => (
            <Text
              key={id}
              variant="mono"
              size="xs"
              style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}
            >
              {id}
            </Text>
          ))}
        </Column>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentChatHistoryProps {
  runId: string;
  /** Select a specific agent step's turn (rare multi-agent-step case); default = latest. */
  stepId?: string;
}

export function AgentChatHistory({ runId, stepId }: AgentChatHistoryProps) {
  const query = useApiQuery<ChatHistoryResponse>({
    key: ['session', runId, 'chat-history', stepId ?? 'latest'],
    path: `/sessions/${runId}/chat-history${stepId ? `?stepId=${encodeURIComponent(stepId)}` : ''}`,
    enabled: !!runId,
    staleTime: 5_000,
  });
  const data = query.data ?? null;
  const loading = query.isLoading;
  const isNoData = query.error?.status === 404;

  if (loading && !data) {
    return (
      <Row gap="2" align="center" style={{ padding: 'var(--space-3) 0' }}>
        <Spinner size="sm" />
        <Text variant="muted" size="sm">
          Loading conversation…
        </Text>
      </Row>
    );
  }

  if (isNoData) {
    return (
      <Column gap="2">
        <Text variant="muted" size="sm">
          No agent chat history yet. History appears after the first agent turn completes.
        </Text>
        <button
          onClick={() => void query.refetch()}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--color-text-link)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          Refresh
        </button>
      </Column>
    );
  }

  if (query.error) {
    return (
      <Column gap="2">
        <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
          {query.error.message}
        </Text>
        <button
          onClick={() => void query.refetch()}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--color-text-link)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          Retry
        </button>
      </Column>
    );
  }

  if (!data) return null;

  const {
    messages,
    modelOutput,
    decision,
    model,
    usage,
    contextWindow,
    tokenEstimate,
    toolSurface,
  } = data;
  const totalTokens = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
  const perMessageTokens = estimatePerMessageTokens(messages);

  return (
    <Column gap="2">
      {tokenEstimate ? (
        <TokenBar
          tokenEstimate={tokenEstimate}
          promptTokens={usage?.promptTokens}
          contextWindow={contextWindow}
        />
      ) : null}

      {toolSurface ? <ToolSurfaceSection surface={toolSurface} /> : null}
      {toolSurface?.discoverable ? (
        <DiscoverableSection discoverable={toolSurface.discoverable} />
      ) : null}

      <Row gap="2" align="center" style={{ flexWrap: 'wrap' }}>
        {model && (
          <Text
            variant="mono"
            size="xs"
            style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}
          >
            {model}
          </Text>
        )}
        {totalTokens > 0 && (
          <Text variant="muted" size="xs" style={{ fontSize: '10px' }}>
            {formatNum(usage?.promptTokens ?? 0)} in / {formatNum(usage?.completionTokens ?? 0)} out
          </Text>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          style={{
            all: 'unset',
            cursor: query.isFetching ? 'default' : 'pointer',
            color: 'var(--color-text-link)',
            fontSize: '10px',
            opacity: query.isFetching ? 0.5 : 1,
          }}
        >
          {query.isFetching ? 'Loading…' : 'Refresh'}
        </button>
      </Row>

      <Column gap="4">
        {messages.map((msg, i) => (
          <ChatMessageRow key={i} message={msg} estimatedTokens={perMessageTokens[i]} />
        ))}

        {(modelOutput || decision) && (
          <>
            <div
              style={{
                borderTop: '1px dashed var(--color-border-subtle)',
                margin: 'var(--space-1) 0',
                position: 'relative',
              }}
            >
              <Text
                variant="muted"
                size="xs"
                style={{
                  position: 'absolute',
                  top: '-8px',
                  left: 'var(--space-2)',
                  backgroundColor: 'var(--color-surface-1)',
                  padding: '0 var(--space-1)',
                  fontSize: '9px',
                }}
              >
                model response
              </Text>
            </div>
            <ChatMessageRow message={buildResponseMessage(modelOutput, decision)} />
          </>
        )}
      </Column>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// RichText — renders text with markdown/plain detection
// ---------------------------------------------------------------------------

function RichText({ text, collapsed }: { text: string; collapsed: boolean }) {
  if (looksLikeMarkdown(text)) {
    return (
      <div
        style={{
          maxHeight: collapsed ? '300px' : 'none',
          overflow: collapsed ? 'hidden' : 'visible',
        }}
      >
        <MarkdownRenderer content={text} className="chat-history-md" jsonTree />
      </div>
    );
  }

  const display = collapsed && text.length > 200 ? text.slice(0, 200) + '…' : text;
  return (
    <Text
      size="xs"
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
        maxHeight: collapsed ? '200px' : 'none',
        overflow: collapsed ? 'hidden' : 'visible',
      }}
    >
      {display}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// ChatMessageRow
// ---------------------------------------------------------------------------

function ChatMessageRow({
  message,
  estimatedTokens,
}: {
  message: AiMessage;
  estimatedTokens?: number | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const textContent = renderTextContent(message);
  const jsonParts = getJsonParts(message);
  const role = message.role ?? 'system';
  const style = ROLE_STYLES[role] ?? SYSTEM_ROLE_STYLE;
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  const roleLabel = (() => {
    if (role === 'tool' && message.name) return `Tool: ${message.name}`;
    return style.label;
  })();

  // System messages are document-like prompts — render as a single markdown block
  // without JSON splitting, so embedded JSON examples stay inline as code blocks.
  const isDocumentLike = role === 'system' && looksLikeMarkdown(textContent);

  const segments = isDocumentLike ? [] : splitTextAndJson(textContent);

  // Detect agent decision objects and deduplicate their message text
  const agentActions = segments
    .filter((s): s is ContentSegment & { kind: 'json' } => s.kind === 'json')
    .map((s) => extractAgentAction(s.data))
    .filter((a): a is NonNullable<typeof a> => a !== null);
  const agentMessageTexts = new Set(agentActions.map((a) => a.message).filter(Boolean));

  const filteredSegments =
    agentActions.length > 0
      ? segments.filter((s) => {
          if (s.kind === 'text' && agentMessageTexts.has(s.text.trim())) return false;
          return true;
        })
      : segments;

  // Track step names already rendered in decision cards to skip duplicate tool calls
  const coveredToolNames = new Set<string>();
  for (const a of agentActions) {
    if (a.action === 'invoke_step' && typeof a.raw['stepId'] === 'string') {
      coveredToolNames.add(a.raw['stepId']);
    }
    if (a.action === 'invoke_steps' && Array.isArray(a.raw['calls'])) {
      for (const call of a.raw['calls'] as Array<Record<string, unknown>>) {
        if (typeof call['stepId'] === 'string') coveredToolNames.add(call['stepId']);
      }
    }
  }

  const totalTextChars = isDocumentLike
    ? textContent.length
    : filteredSegments
        .filter((s): s is ContentSegment & { kind: 'text' } => s.kind === 'text')
        .reduce((sum, s) => sum + s.text.length, 0);
  const hasLongText = totalTextChars > 200;

  return (
    <div
      style={{
        padding: 'var(--space-2) var(--space-2)',
        borderRadius: 'var(--radius-md)',
        backgroundColor: style.bg,
        borderLeft: `0px none ${style.border}`,
      }}
    >
      <Row gap="1" align="center" style={{ marginBottom: '2px' }}>
        <Icon name={style.icon} size="xs" color={style.border} />
        <Text
          size="xs"
          style={{
            fontWeight: 'var(--font-weight-semibold)',
            color: style.border,
            textTransform: 'uppercase',
          }}
        >
          {roleLabel}
        </Text>
        {estimatedTokens != null && estimatedTokens > 0 && (
          <>
            <div style={{ flex: 1 }} />
            <Text
              variant="mono"
              size="xs"
              style={{ color: 'var(--color-text-muted)', fontSize: '9px', opacity: 0.7 }}
            >
              ~{formatNum(estimatedTokens)} tokens
            </Text>
          </>
        )}
      </Row>

      {isDocumentLike && textContent && (
        <RichText text={textContent} collapsed={hasLongText && !expanded} />
      )}

      {!isDocumentLike && filteredSegments.length > 0 && (
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
          }}
        >
          {filteredSegments.map((seg, i) => {
            if (seg.kind === 'json') {
              const aa = extractAgentAction(seg.data);
              if (aa) return <AgentDecisionCard key={i} agentAction={aa} />;
              return <JsonViewer key={i} data={seg.data} collapseDepth={2} maxHeight="280px" />;
            }
            return <RichText key={i} text={seg.text} collapsed={hasLongText && !expanded} />;
          })}
        </div>
      )}

      {jsonParts.map((json, i) => {
        const aa = extractAgentAction(json);
        return (
          <div key={`json-${i}`} style={{ marginTop: 'var(--space-1)' }}>
            {aa ? (
              <AgentDecisionCard agentAction={aa} />
            ) : (
              <JsonViewer data={json} collapseDepth={2} maxHeight="200px" />
            )}
          </div>
        );
      })}

      {hasToolCalls && message.toolCalls && (
        <div
          style={{
            marginTop: 'var(--space-1)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          {message.toolCalls
            .filter((tc) => !coveredToolNames.has(tc.name))
            .map((tc, i) => (
              <div key={i}>
                <Badge variant="neutral" style={{ fontSize: '9px' }}>
                  {tc.name}
                </Badge>
                {tc.argumentsJson != null && (
                  <div style={{ marginTop: '2px' }}>
                    <JsonViewer data={tc.argumentsJson} collapseDepth={1} maxHeight="120px" />
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {hasLongText && (
        <button
          onClick={() => {
            setExpanded((v) => !v);
          }}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--color-text-muted)',
            fontSize: '10px',
            marginTop: 'var(--space-1)',
            display: 'block',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
