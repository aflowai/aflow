'use client';

import { useState } from 'react';
import { Text, Row, JsonViewer, Icon, type IconName } from '@aflow/design-system';
import { MarkdownRenderer } from '../markdown-renderer.js';
import { looksLikeMarkdown } from '../../lib/content-detection.js';

// ---------------------------------------------------------------------------
// Agent action detection
// ---------------------------------------------------------------------------

const AGENT_ACTIONS = new Set(['invoke_step', 'invoke_steps', 'pause_for_input', 'complete']);

export interface AgentAction {
  action: string;
  message?: string | undefined;
  /** Asked-for reasoning — the `reasoning` field the model fills in its JSON decision. */
  reasoning?: string | undefined;
  /** Native model thinking — chain-of-thought from reasoning-capable models, surfaced by the provider. */
  thinking?: string | undefined;
  raw: Record<string, unknown>;
}

export function extractAgentAction(data: unknown): AgentAction | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj['action'] !== 'string' || !AGENT_ACTIONS.has(obj['action'])) return null;

  return {
    action: obj['action'],
    message: typeof obj['message'] === 'string' ? obj['message'] : undefined,
    reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'] : undefined,
    thinking: typeof obj['thinking'] === 'string' ? obj['thinking'] : undefined,
    raw: obj,
  };
}

// ---------------------------------------------------------------------------
// Action config — visual treatment per decision type
// ---------------------------------------------------------------------------

interface ActionStyle {
  icon: IconName;
  label: string;
  color: string;
}

const ACCENT = 'var(--color-text-primary)';

const ACTION_CONFIG: Record<string, ActionStyle> = {
  invoke_step: { icon: 'arrow-right', label: 'Invoking', color: ACCENT },
  invoke_steps: { icon: 'expand', label: 'Invoking', color: ACCENT },
  complete: { icon: 'check', label: 'Completed', color: ACCENT },
  pause_for_input: { icon: 'pause', label: 'Awaiting input', color: ACCENT },
};

const FALLBACK_CONFIG: ActionStyle = {
  icon: 'chat',
  label: 'Action',
  color: 'var(--color-text-secondary)',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MessageText({ text }: { text: string }) {
  if (looksLikeMarkdown(text)) {
    return <MarkdownRenderer content={text} className="chat-history-md" />;
  }
  return (
    <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
      {text}
    </Text>
  );
}

function StepTargets({ agentAction }: { agentAction: AgentAction }) {
  const { action, raw } = agentAction;

  if (action === 'invoke_step' && typeof raw['stepId'] === 'string') {
    return (
      <Text size="xs" style={{ fontWeight: 600, fontFamily: 'var(--font-family-mono)' }}>
        {raw['stepId']}
      </Text>
    );
  }

  if (action === 'invoke_steps' && Array.isArray(raw['calls'])) {
    const calls = raw['calls'] as Array<Record<string, unknown>>;
    return (
      <Row gap="1" align="center">
        {calls.map((call, i) => (
          <Text
            key={i}
            size="xs"
            style={{ fontWeight: 600, fontFamily: 'var(--font-family-mono)' }}
          >
            {typeof call['stepId'] === 'string' ? call['stepId'] : `call-${i}`}
            {i < calls.length - 1 ? ',' : ''}
          </Text>
        ))}
      </Row>
    );
  }

  return null;
}

function ActionPayload({ agentAction }: { agentAction: AgentAction }) {
  const { action, raw } = agentAction;

  if (action === 'invoke_step' && raw['args'] != null) {
    return <JsonViewer data={raw['args']} collapseDepth={2} maxHeight="200px" />;
  }
  if (action === 'invoke_steps' && Array.isArray(raw['calls'])) {
    return <JsonViewer data={raw['calls']} collapseDepth={2} maxHeight="200px" />;
  }
  if (action === 'complete' && raw['result'] != null) {
    return <JsonViewer data={raw['result']} collapseDepth={2} maxHeight="200px" />;
  }
  if (action === 'pause_for_input') {
    const respOpts = raw['responseOptions'] as
      { type?: string; options?: Array<{ value: string; label?: string }> } | undefined;
    if (respOpts?.options) {
      return (
        <Row gap="1" style={{ flexWrap: 'wrap', padding: '2px 0' }}>
          {respOpts.options.map((opt, i) => (
            <Text
              key={i}
              size="xs"
              style={{
                backgroundColor: 'var(--color-surface-2)',
                padding: '2px 8px',
                borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-family-mono)',
              }}
            >
              {opt.label ?? opt.value}
            </Text>
          ))}
          <Text size="xs" variant="muted">
            ({respOpts.type === 'multi' ? 'multi-select' : 'single-select'})
          </Text>
        </Row>
      );
    }
    if (raw['inputSchema'] != null) {
      return <JsonViewer data={raw['inputSchema']} collapseDepth={1} maxHeight="120px" />;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Disclosure toggle
// ---------------------------------------------------------------------------

function DisclosureToggle({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        color: 'var(--color-text-muted)',
        fontSize: '10px',
      }}
    >
      <Icon name={open ? 'caret-down' : 'caret-right'} size="xs" color="var(--color-text-muted)" />
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// AgentDecisionCard
// ---------------------------------------------------------------------------

export function AgentDecisionCard({ agentAction }: { agentAction: AgentAction }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const { action, message, reasoning, thinking, raw } = agentAction;
  const config = ACTION_CONFIG[action] ?? FALLBACK_CONFIG;

  const prompt =
    typeof raw['prompt'] === 'string' && raw['prompt'] !== message ? raw['prompt'] : undefined;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      {/* Message (above action) */}
      {!showRaw && message && <MessageText text={message} />}
      {!showRaw && prompt && <MessageText text={prompt} />}

      {/* Action bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          flexWrap: 'wrap',
          backgroundColor: 'var(--color-surface-1)',
          padding: '5px 10px',
          borderRadius: 'var(--radius-md)',
          marginTop: 'var(--space-1)',
        }}
      >
        <Icon name={config.icon} size="xs" color={config.color} />
        <Text size="xs" style={{ color: config.color }}>
          {config.label}
        </Text>
        <StepTargets agentAction={agentAction} />

        <button
          onClick={() => {
            setShowRaw((v) => !v);
          }}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            color: 'var(--color-text-muted)',
            fontSize: '10px',
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        >
          <Icon name="code" size="xs" color="var(--color-text-muted)" />
          <span>{showRaw ? 'Formatted' : 'Raw'}</span>
        </button>
      </div>

      {/* Body: raw JSON or formatted content */}
      {showRaw ? (
        <JsonViewer data={raw} collapseDepth={3} maxHeight="400px" />
      ) : (
        <>
          {/* Payload */}
          <ActionPayload agentAction={agentAction} />

          {/* Reasoning disclosure (asked-for: the `reasoning` field the model fills) */}
          {reasoning && (
            <div>
              <DisclosureToggle
                label="Reasoning"
                open={showReasoning}
                onToggle={() => {
                  setShowReasoning((v) => !v);
                }}
              />
              {showReasoning && (
                <Text
                  size="xs"
                  variant="muted"
                  style={{
                    fontStyle: 'italic',
                    fontSize: 'var(--font-size-xs)',
                    lineHeight: 1.5,
                    marginTop: '2px',
                    paddingLeft: 'var(--space-2)',
                    borderLeft: '2px solid var(--color-border-subtle)',
                  }}
                >
                  {reasoning}
                </Text>
              )}
            </div>
          )}

          {/* Thinking disclosure (native: model's chain-of-thought from reasoning-capable models) */}
          {thinking && (
            <div>
              <DisclosureToggle
                label="Thinking"
                open={showThinking}
                onToggle={() => {
                  setShowThinking((v) => !v);
                }}
              />
              {showThinking && (
                <Text
                  size="xs"
                  variant="muted"
                  style={{
                    fontFamily: 'var(--font-family-mono)',
                    fontSize: 'var(--font-size-xs)',
                    lineHeight: 1.5,
                    marginTop: '2px',
                    paddingLeft: 'var(--space-2)',
                    borderLeft: '2px solid var(--color-border-subtle)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: '300px',
                    overflowY: 'auto',
                  }}
                >
                  {thinking}
                </Text>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
