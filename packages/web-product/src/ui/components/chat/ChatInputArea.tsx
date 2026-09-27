'use client';

import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AnimatedHeight,
  ChatComposer,
  Button,
  Column,
  Icon,
  IconButton,
  Input,
  List,
  ListItem,
  Popover,
  Row,
  Select,
  Text,
  Textarea,
  ToggleChip,
  Tooltip,
  useBreakpoint,
} from '@aflow/design-system';
import type { PrimaryInputDescriptor } from '@aflow/schemas';

// Re-export for consumers that imported from here.
export type { PrimaryInputDescriptor };

/** Voice session state passed from parent. */
export type VoiceState = 'idle' | 'connecting' | 'active' | 'error';

/** How much room a composer control has: a toolbar chip, or a full menu row. */
export type ComposerControlVariant = 'chip' | 'menu-item';

interface ChatInputAreaProps {
  /** Called when the user submits a message. */
  onSubmit: (content: string) => void;
  /** Fires as the person types, so a shared room can show it. */
  onTyping?: () => void;
  /** Whether submission is in progress. */
  loading: boolean;
  /** Whether the composer is disabled (no flow selected, or run is active). */
  disabled: boolean;
  /** Current run status (null = no run). */
  runStatus: string | null;
  /** Whether the run is actively processing (QUEUED or RUNNING). */
  isRunActive: boolean;
  delegatingToWorkflow?: boolean;
  /** Primary input descriptor for schema-aware input rendering. */
  primaryInput?: PrimaryInputDescriptor | null | undefined;
  /** Called when the user clicks interrupt. */
  onCancelRun: () => void;
  /** Whether an interrupt request is in-flight (waiting for current step to finish). */
  isInterrupting?: boolean;
  /** Whether the run inspector is currently shown. */
  showRunInspector: boolean;
  /** Whether there's an active run to inspect. */
  hasCurrentRun: boolean;
  /** Called when the user toggles the inspector. */
  onToggleRunInspector: () => void;
  /** Show the composer's inspector toggle. Off for cybernetic — the dock has
   *  its own collapse/expand rail (Plan 228). Default true. */
  showInspectorToggle?: boolean;
  /** Voice session state. */
  voiceState?: VoiceState;
  /** Whether the agent is speaking (voice mode). */
  voiceIsSpeaking?: boolean;
  /** Voice error message (shown in tooltip). */
  voiceError?: string | null | undefined;
  /** Called to start voice mode. */
  onVoiceConnect?: (() => void) | undefined;
  /** Called to stop voice mode. */
  onVoiceDisconnect?: (() => void) | undefined;
  /** Current mic mode (open-mic or push-to-talk). */
  voiceMicMode?: 'open' | 'push-to-talk';
  /** Toggle mic mode. */
  onVoiceMicModeChange?: (mode: 'open' | 'push-to-talk') => void;
  /** Enable/disable mic (for push-to-talk). */
  onVoiceMicToggle?: (enabled: boolean) => void;
  /** Whether the mic is currently enabled. */
  voiceMicEnabled?: boolean;
  /** Structured response options from agent pause_for_input (when PAUSED). */
  responseOptions?:
    | {
        type: 'single' | 'multi';
        options: Array<{ value: string; label?: string | undefined }>;
      }
    | undefined;
  /**
   * Agent-level configuration (models, tools, …). Called with the presentation
   * the composer has room for: chips in the action bar, or rows in the overflow
   * menu when a phone folds the bar away.
   */
  agentSettings?: ((variant: ComposerControlVariant) => ReactNode) | undefined;
  /**
   * What pressing send will do. Stays on the surface in every layout — it
   * decides whether the next message wakes the agent, which is not a thing to
   * discover behind a menu.
   */
  sendModeControl?: ReactNode;
  /** Editable prefill text for the composer (Workbench quick-starts, Plan 228 §5.3). */
  seedValue?: string;
  seedNonce?: number;
}

// ---------------------------------------------------------------------------
// ChatInputArea
// ---------------------------------------------------------------------------

export function ChatInputArea({
  onSubmit,
  onTyping,
  loading,
  disabled,
  runStatus,
  isRunActive,
  delegatingToWorkflow = false,
  primaryInput,
  onCancelRun,
  isInterrupting = false,
  showRunInspector,
  hasCurrentRun,
  onToggleRunInspector,
  showInspectorToggle = true,
  voiceState = 'idle',
  voiceIsSpeaking = false,
  voiceError = null,
  onVoiceConnect,
  onVoiceDisconnect,
  voiceMicMode = 'open',
  onVoiceMicModeChange,
  onVoiceMicToggle,
  voiceMicEnabled = true,
  responseOptions,
  agentSettings,
  sendModeControl,
  seedValue,
  seedNonce,
}: ChatInputAreaProps) {
  const { isMobile } = useBreakpoint();

  const handleSubmit = useCallback(
    (content: string) => {
      onSubmit(content);
    },
    [onSubmit],
  );

  const showStopButton =
    isRunActive &&
    (runStatus === 'RUNNING' ||
      runStatus === 'QUEUED' ||
      runStatus === 'WAITING_ON_CHILD' ||
      delegatingToWorkflow);

  // ── Primary input schema analysis ──
  const enumValues = useMemo(() => {
    if (!primaryInput) return null;
    const e = primaryInput.typeSchema['enum'];
    return Array.isArray(e) ? e.map(String) : null;
  }, [primaryInput]);
  const inputType = primaryInput?.typeSchema['type'] as string | undefined;
  const isBooleanInput = inputType === 'boolean';
  const isNumberInput = inputType === 'number' || inputType === 'integer';

  // Object with defined properties → structured form
  const objectFields = useMemo(() => {
    if (!primaryInput || inputType !== 'object') return null;
    const props = primaryInput.typeSchema['properties'] as
      Record<string, Record<string, unknown>> | undefined;
    if (!props || Object.keys(props).length === 0) return null;
    const req = new Set(
      Array.isArray(primaryInput.typeSchema['required'])
        ? (primaryInput.typeSchema['required'] as string[])
        : [],
    );
    return Object.entries(props).map(([key, schema]) => ({
      key,
      type: typeof schema['type'] === 'string' ? schema['type'] : 'string',
      description: typeof schema['description'] === 'string' ? schema['description'] : '',
      required: req.has(key),
    }));
  }, [primaryInput, inputType]);

  const hasSpecialInput = !!enumValues || isBooleanInput || !!objectFields;

  // State for enum/boolean selection
  const [selectedEnum, setSelectedEnum] = useState<string>('');

  // State for object form fields
  const [objectValues, setObjectValues] = useState<Record<string, string>>({});
  const handleObjectFieldChange = useCallback((key: string, value: string) => {
    setObjectValues((prev) => ({ ...prev, [key]: value }));
  }, []);
  const handleObjectSubmit = useCallback(() => {
    if (!objectFields) return;
    const result: Record<string, unknown> = {};
    for (const field of objectFields) {
      const raw = objectValues[field.key] ?? '';
      if (!raw && !field.required) continue;
      if (field.type === 'number' || field.type === 'integer') {
        const n = Number(raw);
        result[field.key] = isNaN(n) ? raw : n;
      } else if (field.type === 'boolean') {
        result[field.key] = raw === 'true';
      } else if (field.type === 'object' || field.type === 'array') {
        try {
          result[field.key] = JSON.parse(raw);
        } catch {
          result[field.key] = raw;
        }
      } else {
        result[field.key] = raw;
      }
    }
    handleSubmit(JSON.stringify(result));
    setObjectValues({});
  }, [objectFields, objectValues, handleSubmit]);

  // ── Response options state (agent-provided structured choices) ──
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [optionsCollapsed, setOptionsCollapsed] = useState(false);
  const prevResponseOptionsRef = useRef(responseOptions);

  // Reset selection + collapse when responseOptions changes (new pause)
  useEffect(() => {
    if (prevResponseOptionsRef.current !== responseOptions) {
      setSelectedOptions(new Set());
      setOptionsCollapsed(false);
      prevResponseOptionsRef.current = responseOptions;
    }
  }, [responseOptions]);

  const hasResponseOptions = !!responseOptions && responseOptions.options.length >= 2;
  const isMultiSelect = responseOptions?.type === 'multi';
  // Always cap height with scroll — keeps long option lists from pushing the
  // chat history off-screen. ~5 chips fit before scrolling kicks in.
  const optionsListMaxHeight = 220;

  const handleOptionToggle = useCallback(
    (value: string) => {
      setSelectedOptions((prev) => {
        const next = new Set(prev);
        if (isMultiSelect) {
          if (next.has(value)) next.delete(value);
          else next.add(value);
        } else {
          if (next.has(value)) next.clear();
          else {
            next.clear();
            next.add(value);
          }
        }
        return next;
      });
    },
    [isMultiSelect],
  );

  const handleOptionsSubmit = useCallback(() => {
    if (selectedOptions.size === 0) return;
    if (isMultiSelect) {
      handleSubmit(JSON.stringify([...selectedOptions]));
    } else {
      const [first] = selectedOptions;
      if (first) handleSubmit(first);
    }
    setSelectedOptions(new Set());
  }, [selectedOptions, isMultiSelect, handleSubmit]);

  // ── Container styles ──
  const isVoiceMode = voiceState === 'active' || voiceState === 'connecting';
  const showsInputHint =
    !isVoiceMode &&
    !!primaryInput &&
    ((primaryInput.description ?? '').length > 0 || hasSpecialInput || isNumberInput);
  const usesFreeformComposer = !isVoiceMode && !enumValues && !isBooleanInput && !objectFields;

  // Phones fold the action bar into the composer pill — an overflow menu on the
  // left, run state on the right — so the input area stays a single row. The
  // schema-driven inputs (enum, boolean, object form) have no pill to fold into
  // and keep the bar.
  const foldControlsIntoComposer = isMobile && usesFreeformComposer;
  // With nothing riding above it the pill *is* the input area, so the wrapper's
  // own surface would only draw a second, larger box around it.
  const bareComposer = foldControlsIntoComposer && !showsInputHint && !hasResponseOptions;

  const containerStyle: CSSProperties = bareComposer
    ? { marginInline: 'auto', maxWidth: 680, width: '100%' }
    : {
        backgroundColor: 'var(--surface-raised-alpha)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: isMobile
          ? 'none'
          : isVoiceMode
            ? '1px solid rgba(120, 100, 200, 0.2)'
            : '1px solid transparent',
        borderRadius: isVoiceMode ? 'var(--radius-xl)' : 'var(--radius-lg)',
        marginInline: 'auto',
        padding: isVoiceMode ? '0 0 var(--space-4) 0' : '7px',
        maxWidth: 680,
        width: '100%',
        overflow: 'hidden',
        transition: 'border-color 300ms ease, border-radius 300ms ease, padding 300ms ease',
      };

  return (
    <div className="ds-composer-shell" style={containerStyle}>
      <AnimatedHeight>
        {/* Voice panel — replaces text input when voice is active or connecting */}
        {(voiceState === 'active' || voiceState === 'connecting') && (
          <VoicePanel
            connecting={voiceState === 'connecting'}
            isSpeaking={voiceIsSpeaking}
            micMode={voiceMicMode}
            micEnabled={voiceMicEnabled}
            onMicModeChange={onVoiceMicModeChange}
            onMicToggle={onVoiceMicToggle}
            onDisconnect={onVoiceDisconnect}
          />
        )}

        {/* Input hint — show expected type/description when non-text */}
        {showsInputHint && primaryInput && (
          <div
            style={{
              padding: 'var(--space-1) var(--space-3)',
              borderBottom: '1px solid var(--color-border-subtle)',
            }}
          >
            <Text size="xs" variant="muted">
              {primaryInput.description ?? primaryInput.name}
              {hasSpecialInput || isNumberInput
                ? ` (${enumValues ? 'select one' : isBooleanInput ? 'yes/no' : inputType})`
                : ''}
            </Text>
          </div>
        )}

        {/* Response options — structured choices above the composer.
          Collapsible header + capped scroll height so a long option list never
          pushes the chat history off-screen. */}
        {voiceState !== 'active' && voiceState !== 'connecting' && hasResponseOptions && (
          <div
            style={{
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-border-subtle)',
            }}
          >
            <Column gap="2">
              <Row
                align="center"
                justify="between"
                onClick={() => {
                  setOptionsCollapsed((c) => !c);
                }}
                style={{ cursor: 'pointer', userSelect: 'none' }}
                role="button"
                aria-expanded={!optionsCollapsed}
                aria-label={optionsCollapsed ? 'Show options' : 'Hide options'}
              >
                <Text size="xs" variant="muted">
                  {isMultiSelect ? 'Select one or more' : 'Select one'}
                  {optionsCollapsed ? ` · ${String(responseOptions.options.length)} hidden` : ''}
                </Text>
                <Icon
                  name={optionsCollapsed ? 'caret-down' : 'caret-up'}
                  size="xs"
                  style={{ opacity: 0.6 }}
                />
              </Row>

              {!optionsCollapsed && (
                <>
                  <List gap="xs" style={{ maxHeight: optionsListMaxHeight, overflowY: 'auto' }}>
                    {responseOptions.options.map((opt) => (
                      <ListItem
                        key={opt.value}
                        title={opt.label ?? opt.value}
                        clickable
                        selected={selectedOptions.has(opt.value)}
                        disabled={disabled}
                        onClick={() => {
                          if (isMultiSelect) {
                            handleOptionToggle(opt.value);
                          } else {
                            handleSubmit(opt.value);
                            setSelectedOptions(new Set());
                          }
                        }}
                      />
                    ))}
                  </List>

                  {/* Multi-select: send button for the selection */}
                  {isMultiSelect && selectedOptions.size > 0 && (
                    <Row align="center" justify="end">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={loading || disabled}
                        onClick={handleOptionsSubmit}
                      >
                        Send {selectedOptions.size} selected
                      </Button>
                    </Row>
                  )}
                </>
              )}
            </Column>
          </div>
        )}

        {/* Text input area — hidden when voice is active */}
        {voiceState !== 'active' &&
          voiceState !== 'connecting' &&
          (enumValues ? (
            <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
              <Row gap="2" align="center">
                <Select
                  value={selectedEnum}
                  onChange={(e) => {
                    setSelectedEnum(e.target.value);
                  }}
                  disabled={disabled}
                  style={{ flex: 1 }}
                >
                  <option value="">— Choose {primaryInput?.name ?? 'value'} —</option>
                  {enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!selectedEnum || loading || disabled}
                  onClick={() => {
                    if (selectedEnum) {
                      handleSubmit(selectedEnum);
                      setSelectedEnum('');
                    }
                  }}
                >
                  Send
                </Button>
              </Row>
            </div>
          ) : isBooleanInput ? (
            <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
              <Row gap="2" align="center" justify="center">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loading || disabled}
                  onClick={() => {
                    handleSubmit('true');
                  }}
                >
                  Yes
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loading || disabled}
                  onClick={() => {
                    handleSubmit('false');
                  }}
                >
                  No
                </Button>
              </Row>
            </div>
          ) : objectFields ? (
            /* Object with defined properties — structured form */
            <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
              <Column gap="2">
                {objectFields.map((field) => (
                  <Row key={field.key} gap="2" align="start">
                    <div style={{ flex: 1 }}>
                      <Row gap="1" align="center" style={{ marginBottom: 'var(--space-1)' }}>
                        <Text size="xs" style={{ fontWeight: 600 }}>
                          {field.key}
                        </Text>
                        <Text size="xs" variant="muted">
                          {field.type}
                        </Text>
                        {field.required && (
                          <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
                            *
                          </Text>
                        )}
                      </Row>
                      {field.type === 'object' || field.type === 'array' ? (
                        <Textarea
                          value={objectValues[field.key] ?? ''}
                          onChange={(e) => {
                            handleObjectFieldChange(field.key, e.target.value);
                          }}
                          placeholder={field.description || `${field.type}…`}
                          rows={2}
                          disabled={disabled}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--font-size-xs)',
                          }}
                        />
                      ) : (
                        <Input
                          value={objectValues[field.key] ?? ''}
                          onChange={(e) => {
                            handleObjectFieldChange(field.key, e.target.value);
                          }}
                          placeholder={field.description || `${field.key}…`}
                          type={
                            field.type === 'number' || field.type === 'integer' ? 'number' : 'text'
                          }
                          disabled={disabled}
                          style={{ fontSize: 'var(--font-size-sm)' }}
                        />
                      )}
                    </div>
                  </Row>
                ))}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={
                    loading ||
                    disabled ||
                    objectFields.some((f) => f.required && !objectValues[f.key]?.trim())
                  }
                  onClick={handleObjectSubmit}
                  style={{ alignSelf: 'end' }}
                >
                  Send
                </Button>
              </Column>
            </div>
          ) : (
            /* Default: freeform textarea (text, number, object, etc.) */
            <ChatComposer
              onSubmit={handleSubmit}
              {...(onTyping ? { onTyping } : {})}
              loading={loading}
              disabled={disabled}
              autoFocus
              {...(seedValue !== undefined ? { seedValue } : {})}
              {...(seedNonce !== undefined ? { seedNonce } : {})}
              {...(foldControlsIntoComposer
                ? {
                    leading: <ComposerOverflowMenu rows={agentSettings?.('menu-item')} />,
                    trailing: (
                      <>
                        {/* Interrupting and choosing who hears the next message
                            never apply at the same moment, so they share a slot
                            instead of both crowding the row. */}
                        {showStopButton ? (
                          <InterruptButton
                            onCancelRun={onCancelRun}
                            isInterrupting={isInterrupting}
                          />
                        ) : (
                          sendModeControl
                        )}
                        {onVoiceConnect && (
                          <VoiceButton
                            voiceState={voiceState}
                            voiceIsSpeaking={voiceIsSpeaking}
                            voiceError={voiceError}
                            onConnect={onVoiceConnect}
                            onDisconnect={onVoiceDisconnect}
                          />
                        )}
                      </>
                    ),
                  }
                : {})}
            />
          ))}

        {/* Action bar */}
        {!foldControlsIntoComposer && (
          <ActionBar
            agentSettings={agentSettings?.('chip')}
            sendModeControl={sendModeControl}
            showStopButton={showStopButton}
            onCancelRun={onCancelRun}
            isInterrupting={isInterrupting}
            showRunInspector={showRunInspector}
            hasCurrentRun={hasCurrentRun}
            onToggleRunInspector={onToggleRunInspector}
            showInspectorToggle={showInspectorToggle}
            voiceState={voiceState}
            voiceIsSpeaking={voiceIsSpeaking}
            voiceError={voiceError}
            onVoiceConnect={onVoiceConnect}
            onVoiceDisconnect={onVoiceDisconnect}
          />
        )}
      </AnimatedHeight>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action bar — agent settings, stop
// ---------------------------------------------------------------------------

function ActionBar({
  agentSettings,
  sendModeControl,
  showStopButton,
  onCancelRun,
  isInterrupting = false,
  showRunInspector,
  hasCurrentRun,
  onToggleRunInspector,
  showInspectorToggle = true,
  voiceState = 'idle',
  voiceIsSpeaking = false,
  voiceError,
  onVoiceConnect,
  onVoiceDisconnect,
}: {
  agentSettings?: ReactNode | undefined;
  sendModeControl?: ReactNode | undefined;
  showStopButton: boolean;
  onCancelRun: () => void;
  isInterrupting?: boolean;
  showRunInspector: boolean;
  hasCurrentRun: boolean;
  onToggleRunInspector: () => void;
  showInspectorToggle?: boolean;
  voiceState?: VoiceState;
  voiceIsSpeaking?: boolean;
  voiceError?: string | null | undefined;
  onVoiceConnect?: (() => void) | undefined;
  onVoiceDisconnect?: (() => void) | undefined;
}) {
  const hasVoice = !!onVoiceConnect;
  const hasContent =
    agentSettings != null || sendModeControl != null || hasCurrentRun || hasVoice || showStopButton;
  if (!hasContent) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-1) var(--space-2)',
        minHeight: 28,
      }}
    >
      {/* Agent quick settings (model picker, …) */}
      {agentSettings}

      {/* Voice mode toggle */}
      {hasVoice && (
        <VoiceButton
          voiceState={voiceState}
          voiceIsSpeaking={voiceIsSpeaking}
          voiceError={voiceError}
          onConnect={onVoiceConnect}
          onDisconnect={onVoiceDisconnect}
        />
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* What pressing send will do — beside the other send-side controls */}
      {sendModeControl}

      {/* Interrupt button */}
      {showStopButton && (
        <InterruptButton onCancelRun={onCancelRun} isInterrupting={isInterrupting} />
      )}

      {/* Inspector toggle */}
      {showInspectorToggle && hasCurrentRun && (
        <Tooltip content={showRunInspector ? 'Hide inspector' : 'Inspect run'}>
          <ToggleChip
            active={showRunInspector}
            icon={<Icon name="list-magnifying-glass" size="xs" />}
            onClick={onToggleRunInspector}
            aria-label="Inspect run"
          />
        </Tooltip>
      )}
    </div>
  );
}

function InterruptButton({
  onCancelRun,
  isInterrupting,
}: {
  onCancelRun: () => void;
  isInterrupting: boolean;
}) {
  return (
    <Tooltip content={isInterrupting ? 'Interrupting…' : 'Interrupt'}>
      <ToggleChip
        active={isInterrupting}
        icon={<Icon name="pause" size="xs" weight="fill" color="var(--color-warning-default)" />}
        onClick={onCancelRun}
        disabled={isInterrupting}
        aria-label="Interrupt run"
      />
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Composer overflow menu — the phone's home for the action bar's controls
// ---------------------------------------------------------------------------

/**
 * On a phone the composer is the scarcest row on the screen, so configuration —
 * which model answers, what the agent can reach — collapses behind one button
 * and the row keeps its width for typing. Only configuration: the controls that
 * decide what *this* message does (send, interrupt, who hears it, voice) stay on
 * the surface, because a control you have to go looking for mid-run is one you
 * will not reach in time.
 *
 * Rows arrive already built, so each one owns its whole hit target. A row that
 * wraps somebody else's chip leaves the label dead and shows the icon twice.
 */
function ComposerOverflowMenu({ rows }: { rows?: ReactNode }) {
  if (!rows) return null;

  return (
    <Popover
      placement="top-start"
      minWidth={264}
      aria-label="Agent settings"
      panelStyle={{ padding: 'var(--space-1)' }}
      trigger={({ ref, open, toggle }) => (
        <span ref={ref} style={{ display: 'inline-flex' }}>
          <IconButton
            icon={<Icon name="dots-three-vertical" size="sm" />}
            aria-label="Agent settings"
            aria-expanded={open}
            variant="ghost"
            size="sm"
            onClick={toggle}
            style={{ padding: 9, borderRadius: 'var(--radius-full)' }}
          />
        </span>
      )}
    >
      <Column gap="0">{rows}</Column>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Voice panel animations
// ---------------------------------------------------------------------------

const PULSE_KEYFRAMES = `
@keyframes voicePulse {
  0% { box-shadow: 0 0 0 0 rgba(140, 120, 210, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(140, 120, 210, 0); }
  100% { box-shadow: 0 0 0 0 rgba(140, 120, 210, 0); }
}
@keyframes voiceSpeaking {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
}
@keyframes voiceConnecting {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}
@keyframes voiceBarIdle {
  0%, 100% { transform: scaleY(0.08); }
  50% { transform: scaleY(0.2); }
}
@keyframes voiceBarListening {
  0%, 100% { transform: scaleY(0.15); }
  25% { transform: scaleY(0.55); }
  50% { transform: scaleY(0.25); }
  75% { transform: scaleY(0.65); }
}
@keyframes voiceBarSpeaking {
  0%, 100% { transform: scaleY(0.2); }
  15% { transform: scaleY(0.8); }
  30% { transform: scaleY(0.35); }
  45% { transform: scaleY(0.95); }
  60% { transform: scaleY(0.5); }
  75% { transform: scaleY(0.85); }
  90% { transform: scaleY(0.3); }
}
@keyframes voiceBarConnecting {
  0%, 100% { transform: scaleY(0.06); opacity: 0.3; }
  50% { transform: scaleY(0.35); opacity: 0.8; }
}
@keyframes voiceGlowPulse {
  0%, 100% { opacity: 0.15; }
  50% { opacity: 0.4; }
}
@keyframes voiceGlowSpeaking {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 0.65; }
}`;

let pulseStyleInjected = false;

function ensurePulseStyle() {
  if (pulseStyleInjected) return;
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(style);
  pulseStyleInjected = true;
}

// ---------------------------------------------------------------------------
// Voice panel — immersive visualizer that replaces the text composer
// ---------------------------------------------------------------------------

const VOICE_BAR_COUNT = 28;

type VoiceVisualState = 'connecting' | 'speaking' | 'recording' | 'listening' | 'idle';

const VOICE_STATE_COLORS: Record<VoiceVisualState, { accent: string; glow: string }> = {
  connecting: { accent: '#8b8bb8', glow: 'rgba(139, 139, 184, 0.2)' },
  speaking: { accent: '#6b9dd6', glow: 'rgba(107, 157, 214, 0.3)' },
  recording: { accent: '#d67b7b', glow: 'rgba(214, 123, 123, 0.25)' },
  listening: { accent: '#9b7cd6', glow: 'rgba(155, 124, 214, 0.2)' },
  idle: { accent: '#6b6b8a', glow: 'rgba(107, 107, 138, 0.1)' },
};

const VOICE_ANIM_CONFIG: Record<
  VoiceVisualState,
  { name: string; baseDuration: number; barOpacity: number }
> = {
  connecting: { name: 'voiceBarConnecting', baseDuration: 1.5, barOpacity: 0.5 },
  speaking: { name: 'voiceBarSpeaking', baseDuration: 0.7, barOpacity: 0.9 },
  recording: { name: 'voiceBarListening', baseDuration: 0.9, barOpacity: 0.85 },
  listening: { name: 'voiceBarListening', baseDuration: 1.2, barOpacity: 0.75 },
  idle: { name: 'voiceBarIdle', baseDuration: 2.0, barOpacity: 0.35 },
};

function VoicePanel({
  connecting = false,
  isSpeaking,
  micMode,
  micEnabled,
  onMicModeChange,
  onMicToggle,
  onDisconnect,
}: {
  connecting?: boolean;
  isSpeaking: boolean;
  micMode: 'open' | 'push-to-talk';
  micEnabled: boolean;
  onMicModeChange?: ((mode: 'open' | 'push-to-talk') => void) | undefined;
  onMicToggle?: ((enabled: boolean) => void) | undefined;
  onDisconnect?: (() => void) | undefined;
}) {
  useEffect(() => {
    ensurePulseStyle();
  }, []);

  const isPTT = micMode === 'push-to-talk';

  // Determine visual state
  let visualState: VoiceVisualState;
  if (connecting) visualState = 'connecting';
  else if (isSpeaking) visualState = 'speaking';
  else if (isPTT && micEnabled) visualState = 'recording';
  else if (!isPTT && micEnabled) visualState = 'listening';
  else visualState = 'idle';

  const { accent, glow } = VOICE_STATE_COLORS[visualState];
  const { name: animName, baseDuration, barOpacity } = VOICE_ANIM_CONFIG[visualState];

  const statusText = connecting
    ? 'Connecting'
    : isSpeaking
      ? 'Agent speaking'
      : micEnabled
        ? 'Listening'
        : isPTT
          ? 'Hold to speak'
          : 'Mic muted';

  // Glass button base style
  const glassBtn: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-full)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'rgba(255, 255, 255, 0.5)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 150ms ease',
    backdropFilter: 'blur(8px)',
  };

  return (
    <div
      style={{
        position: 'relative',
        background: 'linear-gradient(160deg, #0e0e16 0%, #151320 50%, #0e1318 100%)',
        padding: 'var(--space-5) var(--space-4) var(--space-4)',
      }}
    >
      {/* Ambient glow orb behind bars */}
      <div
        style={{
          position: 'absolute',
          top: '30%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 240,
          height: 100,
          borderRadius: '50%',
          background: `radial-gradient(ellipse, ${glow}, transparent 70%)`,
          animation:
            visualState === 'speaking'
              ? 'voiceGlowSpeaking 1.2s ease-in-out infinite'
              : 'voiceGlowPulse 3s ease-in-out infinite',
          pointerEvents: 'none',
          transition: 'background 500ms ease',
        }}
      />

      {/* Waveform bars */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          height: 56,
          marginBottom: 'var(--space-3)',
        }}
      >
        {Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
          const center = VOICE_BAR_COUNT / 2;
          const dist = Math.abs(i - center) / center;
          const heightScale = 1 - dist * 0.45;
          const delay = Math.sin(i * 0.5) * 0.3 + i * 0.04;
          const duration = baseDuration + Math.sin(i * 0.7) * baseDuration * 0.2;

          return (
            <span
              key={i}
              style={{
                display: 'block',
                width: 3,
                height: 56 * heightScale,
                borderRadius: 2,
                background: `linear-gradient(to top, ${accent}66, ${accent})`,
                transformOrigin: 'center',
                animation: `${animName} ${duration.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
                opacity: barOpacity,
                transition: 'opacity 400ms ease, background 400ms ease',
              }}
            />
          );
        })}
      </div>

      {/* Status label */}
      <div style={{ textAlign: 'center', marginBottom: 'var(--space-3)' }}>
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            fontWeight: 500,
            color: 'rgba(255, 255, 255, 0.45)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {statusText}
        </span>
      </div>

      {/* Controls — invisible during connecting but reserves space */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-2)',
          visibility: connecting ? 'hidden' : 'visible',
          opacity: connecting ? 0 : 1,
          transition: 'opacity 200ms ease',
        }}
      >
        {/* Push-to-talk hold button */}
        {isPTT && (
          <Tooltip content={micEnabled ? 'Release to stop' : 'Hold to speak'}>
            <button
              onMouseDown={() => onMicToggle?.(true)}
              onMouseUp={() => onMicToggle?.(false)}
              onMouseLeave={() => {
                if (micEnabled) onMicToggle?.(false);
              }}
              onTouchStart={() => onMicToggle?.(true)}
              onTouchEnd={() => onMicToggle?.(false)}
              style={{
                ...glassBtn,
                gap: 6,
                padding: '8px 18px',
                border: micEnabled
                  ? '1px solid rgba(214, 123, 123, 0.5)'
                  : '1px solid rgba(255, 255, 255, 0.12)',
                background: micEnabled ? 'rgba(214, 123, 123, 0.12)' : 'rgba(255, 255, 255, 0.05)',
                color: micEnabled ? '#d67b7b' : 'rgba(255, 255, 255, 0.55)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 500,
                userSelect: 'none',
              }}
            >
              <Icon name="microphone" size="xs" weight="fill" />
              {micEnabled ? 'Release' : 'Hold to talk'}
            </button>
          </Tooltip>
        )}

        {/* Mode toggle */}
        <Tooltip content={isPTT ? 'Switch to open mic' : 'Switch to push-to-talk'}>
          <button
            onClick={() => {
              const newMode = isPTT ? 'open' : 'push-to-talk';
              onMicModeChange?.(newMode);
              onMicToggle?.(newMode === 'open');
            }}
            style={{ ...glassBtn, width: 32, height: 32 }}
            aria-label={isPTT ? 'Switch to open mic' : 'Switch to push-to-talk'}
          >
            <Icon name={isPTT ? 'waveform' : 'microphone-stage'} size="xs" />
          </button>
        </Tooltip>

        {/* End session */}
        <Tooltip content="End voice session">
          <button
            onClick={onDisconnect}
            style={{
              ...glassBtn,
              width: 32,
              height: 32,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.06)',
              color: 'rgba(239, 68, 68, 0.7)',
            }}
            aria-label="End voice session"
          >
            <Icon name="x" size="sm" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice button with animation states
// ---------------------------------------------------------------------------

function VoiceButton({
  voiceState,
  voiceIsSpeaking,
  voiceError,
  onConnect,
  onDisconnect,
}: {
  voiceState: VoiceState;
  voiceIsSpeaking: boolean;
  voiceError?: string | null | undefined;
  onConnect?: (() => void) | undefined;
  onDisconnect?: (() => void) | undefined;
}) {
  const isActive = voiceState === 'active';
  const isConnecting = voiceState === 'connecting';
  const useToggleChip = !isActive && !isConnecting;

  useEffect(() => {
    if (isActive || isConnecting) ensurePulseStyle();
  }, [isActive, isConnecting]);

  const tooltipContent =
    voiceState === 'error'
      ? `Voice error: ${voiceError ?? 'unknown'}`
      : isActive
        ? voiceIsSpeaking
          ? 'Agent is speaking…'
          : 'Listening — click to end'
        : isConnecting
          ? 'Connecting…'
          : 'Start voice mode';

  const statusLabel = isActive
    ? voiceIsSpeaking
      ? 'Speaking…'
      : 'Listening'
    : isConnecting
      ? 'Connecting…'
      : null;

  if (useToggleChip) {
    return (
      <Tooltip content={tooltipContent}>
        <ToggleChip
          active={false}
          icon={<Icon name="microphone" size="xs" />}
          onClick={() => onConnect?.()}
          aria-label="Start voice session"
        />
      </Tooltip>
    );
  }

  return (
    <Tooltip content={tooltipContent}>
      <button
        type="button"
        onClick={isActive ? onDisconnect : onConnect}
        aria-label={isActive ? 'End voice session' : 'Start voice session'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: '2px 8px',
          borderRadius: 'var(--radius-full)',
          border: isActive
            ? '1px solid rgba(140, 120, 210, 0.5)'
            : '1px solid var(--color-border-default)',
          background: isActive ? 'rgba(140, 120, 210, 0.1)' : 'var(--color-bg-default)',
          cursor: 'pointer',
          transition: 'all 150ms ease',
          animation:
            isActive && !voiceIsSpeaking
              ? 'voicePulse 2s ease-out infinite'
              : isConnecting
                ? 'voiceConnecting 1.5s ease-in-out infinite'
                : 'none',
        }}
      >
        {/* Mic icon */}
        <Icon
          name="microphone"
          size="xs"
          weight={isActive ? 'fill' : 'regular'}
          style={{
            color: isActive ? 'rgb(140, 120, 210)' : 'var(--color-text-muted)',
          }}
        />

        {/* Mini waveform when agent is speaking */}
        {isActive && voiceIsSpeaking && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 1, height: 12 }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  display: 'block',
                  width: 2,
                  height: 12,
                  borderRadius: 1,
                  backgroundColor: 'rgb(140, 120, 210)',
                  animation: `voiceSpeaking 0.8s ease-in-out ${String(i * 0.15)}s infinite`,
                  transformOrigin: 'center',
                }}
              />
            ))}
          </span>
        )}

        {/* Status label when active */}
        {statusLabel && (
          <Text
            size="xs"
            style={{
              color: isActive ? 'rgb(140, 120, 210)' : 'var(--color-text-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {statusLabel}
          </Text>
        )}
      </button>
    </Tooltip>
  );
}
