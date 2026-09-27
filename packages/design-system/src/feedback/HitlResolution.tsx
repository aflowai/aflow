'use client';

import { useState, type ReactNode, type ReactElement, type CSSProperties } from 'react';
import { Card, CardBody } from '../primitives/Card.js';
import { Button } from '../primitives/Button.js';
import { Badge } from '../primitives/Badge.js';
import { Spinner } from '../primitives/Spinner.js';
import { Text } from '../primitives/Text.js';
import { Column } from '../layout/Column.js';
import { Row } from '../layout/Row.js';
import { Icon } from '../icons/Icon.js';
import { SchemaForm } from './SchemaForm.js';

// ============================================================================
// Public types — local shape that mirrors `@aflow/schemas` ActionCenterItem
// without importing the whole schemas package into the design system.
// ============================================================================

export type HitlItemKind = 'human_input' | 'human_approval' | 'ratification' | 'platform_issue';

export type HitlAllowedAction =
  'submit' | 'approve' | 'reject' | 'ratify' | 'dismiss' | 'comment' | 'reassign';

/** Minimal item shape this component reads. Caller passes the full ActionCenterItem. */
export interface HitlResolutionItem {
  id: string;
  kind: HitlItemKind;
  title: string;
  summary: string;
  /**
   * Free-form JSON Schema for `kind: 'human_input'` items. The
   * dispatcher honours: `boolean`, `enum` (short → buttons / long via
   * `mode: 'form'` → dropdown), flat `object`, `array` of primitives,
   * `string` / `number` / `integer` (via `mode: 'form'`). Anything
   * outside that subset drops to a raw-JSON textarea (the SchemaForm
   * fallback). See `SchemaForm.tsx` for the exact contract.
   */
  resolutionSchema?: Record<string, unknown> | undefined;
  /** Optional UI hints set by the requesting op. */
  uiHints?:
    | {
        mode?: 'text' | 'textarea' | 'form' | 'chat' | 'choices' | 'diff';
        submitLabel?: string;
        approveLabel?: string;
        rejectLabel?: string;
      }
    | undefined;
  /** Computed by the server per requesting user. */
  allowedActions: readonly HitlAllowedAction[];
  /** Set when this item was synthesised by the orchestrator's gate enforcer. */
  gateContext?:
    | {
        operationId: string;
        reason: string;
        bindingId?: string | undefined;
      }
    | undefined;
}

/** Discriminated-union mirror of `ActionCenterResolution`. */
export type HitlResolutionPayload =
  | { kind: 'submit'; payload: unknown }
  | { kind: 'approve'; comment?: string }
  | { kind: 'reject'; reason?: string }
  | { kind: 'ratify' }
  | { kind: 'dismiss'; reason?: string };

export interface HitlResolutionProps {
  item: HitlResolutionItem;
  /**
   * Caller submits the resolution. Returns a promise the host uses for
   * loading state — see `state` for what to render meanwhile.
   */
  onResolve: (resolution: HitlResolutionPayload) => Promise<void>;
  /**
   * Caller-owned UI state for the submit lifecycle:
   *   - 'idle'       → ready, controls enabled
   *   - 'submitting' → spinner, controls disabled
   *   - 'error'      → controls re-enabled (banner visibility is governed
   *                    by `errorMessage`, not by this flag)
   *
   * Server-side error state (e.g. `lastRatificationError` persisted on a
   * proposal) is rendered via `errorMessage` regardless of submit state,
   * so a banner can sit on an idle item.
   */
  state?: 'idle' | 'submitting' | 'error';
  /**
   * Operator-facing error message — shown in a danger banner whenever
   * truthy, independent of `state`. The caller passes either a fresh
   * client-side submit error or a server-side persisted error here.
   */
  errorMessage?: string;
  /**
   * Optional slot for richer body content (e.g. ProposalDiffView for ratifications).
   * Renders above the controls.
   */
  bodySlot?: ReactNode;
  /** Optional style on the controls wrapper (e.g. margin-top in inline chat). */
  controlsStyle?: CSSProperties;
}

// ============================================================================
// Component
// ============================================================================

export function HitlResolution({
  item,
  onResolve,
  state = 'idle',
  errorMessage,
  bodySlot,
  controlsStyle,
}: HitlResolutionProps): ReactElement {
  const submitting = state === 'submitting';

  return (
    <Card
      style={{
        padding: 'var(--space-3)',
        backgroundColor: 'var(--color-accent-bg)',
        border: '1px solid var(--color-accent-fg)',
        width: 'fit-content',
      }}
    >
      <CardBody>
        <Column gap="sm">
          {/* Title row with optional gate hint pill */}
          <Row gap="sm" align="center" wrap>
            <Text size="base" weight="semibold">
              {item.title}
            </Text>
            {item.gateContext && (
              <Badge variant="info" title={`Gate reason: ${item.gateContext.reason}`}>
                Gate: {prettyGateReason(item.gateContext.reason)}
              </Badge>
            )}
          </Row>

          {/* Summary */}
          {item.summary && <Text size="sm">{item.summary}</Text>}

          {/* Gate context detail — small inline disclosure */}
          {item.gateContext && (
            <Text size="xs" variant="muted">
              Gating <strong>{item.gateContext.operationId}</strong>
              {item.gateContext.bindingId ? ` · binding: ${item.gateContext.bindingId}` : ''}
            </Text>
          )}

          {/* Body slot (diff view, evidence list, …) */}
          {bodySlot}

          {/* Error banner — renders whenever the caller supplies a message,
              so server-persisted errors (e.g. lastRatificationError) appear
              on an idle item without waiting for a submit attempt. */}
          {errorMessage && (
            <div
              role="alert"
              style={{
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-danger-default, #ef4444)',
                background: 'var(--color-danger-subtle, rgba(239, 68, 68, 0.08))',
              }}
            >
              <Text size="sm">{errorMessage}</Text>
            </div>
          )}

          {/* Resolution controls */}
          {controlsStyle ? (
            <div style={controlsStyle}>
              <HitlResolutionControls
                item={item}
                onResolve={onResolve}
                disabled={submitting || item.allowedActions.length === 0}
                submitting={submitting}
              />
            </div>
          ) : (
            <HitlResolutionControls
              item={item}
              onResolve={onResolve}
              disabled={submitting || item.allowedActions.length === 0}
              submitting={submitting}
            />
          )}

          {/* No actions available means the item is view-only here (e.g. a
              workflow human task, resolved from the run surface) — not a
              permission problem. The summary above carries the specifics. */}
          {item.allowedActions.length === 0 && state !== 'submitting' && (
            <Text size="xs" variant="muted">
              View-only here — resolve it from the run.
            </Text>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Controls dispatch — picks the right shape per kind + inputSchema
// ============================================================================

interface ControlProps {
  item: HitlResolutionItem;
  onResolve: (r: HitlResolutionPayload) => Promise<void>;
  disabled: boolean;
  submitting: boolean;
}

function HitlResolutionControls(props: ControlProps): ReactElement {
  // Approval-shape items (human_approval, ratification, platform_issue) all
  // use button rows from `allowedActions`.
  if (props.item.kind !== 'human_input') {
    return <ApprovalButtons {...props} />;
  }

  // human_input — pick by schema shape. Order matters:
  //   - boolean → Yes/No (most concrete affordance)
  //   - enum (short OR explicit `choices` mode) → button row
  //   - structured: schema.type is object/array, OR uiHints.mode==='form'
  //     (force the SchemaForm path even for primitives / large enums so
  //     authors get the documented behaviour — see UserRequestInputInputSchema
  //     in `packages/schemas/src/operations/user.ts` where `'form'` is
  //     specified as the SchemaForm trigger)
  //   - anything else → free-form textarea
  //
  // The cap "<=6 enum values" survives because a 3-option enum is
  // faster to click than a dropdown for the >80% case (decisions,
  // severity levels, environment picks). An author who needs a
  // dropdown for a 12-value enum sets `mode: 'form'` and gets one
  // via the StructuredInput → SchemaForm path.
  const schema = props.item.resolutionSchema ?? {};
  const enumValues = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : null;
  const isBoolean = schema['type'] === 'boolean';
  const isChoicesMode = props.item.uiHints?.mode === 'choices';
  const isFormMode = props.item.uiHints?.mode === 'form';
  const isStructuredType = schema['type'] === 'object' || schema['type'] === 'array';

  if (isBoolean) {
    return <BooleanInput {...props} />;
  }
  if (enumValues && (isChoicesMode || enumValues.length <= 6)) {
    return <ChoicesInput {...props} values={enumValues} />;
  }
  if (isFormMode || isStructuredType) {
    return <StructuredInput {...props} schema={schema} />;
  }
  return <FreeFormInput {...props} />;
}

// ============================================================================
// Variants
// ============================================================================

function ApprovalButtons({ item, onResolve, disabled, submitting }: ControlProps): ReactElement {
  const [showRejectComment, setShowRejectComment] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [showDismissReason, setShowDismissReason] = useState(false);
  const [dismissReason, setDismissReason] = useState('');

  const can = (a: HitlAllowedAction): boolean => item.allowedActions.includes(a);
  const approveLabel = item.uiHints?.approveLabel ?? 'Approve';
  const rejectLabel = item.uiHints?.rejectLabel ?? 'Reject';

  return (
    <Column gap="sm">
      <Row gap="sm" wrap>
        {submitting && <Spinner size="sm" label="Submitting…" />}
        {can('ratify') && (
          <Button
            variant="primary"
            size="sm"
            disabled={disabled}
            leftIcon={<Icon name="check" size="sm" />}
            onClick={() => {
              void onResolve({ kind: 'ratify' });
            }}
          >
            Ratify
          </Button>
        )}
        {can('approve') && (
          <Button
            variant="primary"
            size="sm"
            disabled={disabled}
            leftIcon={<Icon name="check" size="sm" />}
            onClick={() => {
              void onResolve({ kind: 'approve' });
            }}
          >
            {approveLabel}
          </Button>
        )}
        {can('reject') && (
          <Button
            variant="danger"
            size="sm"
            disabled={disabled}
            leftIcon={<Icon name="x" size="sm" />}
            onClick={() => {
              setShowRejectComment((v) => !v);
            }}
          >
            {rejectLabel}
          </Button>
        )}
        {can('dismiss') && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setShowDismissReason((v) => !v);
            }}
          >
            Dismiss
          </Button>
        )}
      </Row>

      {showRejectComment && can('reject') && (
        <Column gap="sm">
          <textarea
            value={rejectComment}
            onChange={(e) => {
              setRejectComment(e.target.value);
            }}
            placeholder="Optional reason (helps Coach learn)"
            disabled={disabled}
            rows={2}
            style={textareaStyle}
            aria-label="Reject reason"
          />
          <Row gap="sm">
            <Button
              variant="danger"
              size="sm"
              disabled={disabled}
              onClick={() => {
                void onResolve({
                  kind: 'reject',
                  ...(rejectComment.trim() ? { reason: rejectComment.trim() } : {}),
                });
              }}
            >
              Confirm reject
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setShowRejectComment(false);
              }}
            >
              Cancel
            </Button>
          </Row>
        </Column>
      )}

      {showDismissReason && can('dismiss') && (
        <Column gap="sm">
          <textarea
            value={dismissReason}
            onChange={(e) => {
              setDismissReason(e.target.value);
            }}
            placeholder="Optional acknowledgement note"
            disabled={disabled}
            rows={2}
            style={textareaStyle}
            aria-label="Dismiss reason"
          />
          <Row gap="sm">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                void onResolve({
                  kind: 'dismiss',
                  ...(dismissReason.trim() ? { reason: dismissReason.trim() } : {}),
                });
              }}
            >
              Confirm dismiss
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setShowDismissReason(false);
              }}
            >
              Cancel
            </Button>
          </Row>
        </Column>
      )}
    </Column>
  );
}

function BooleanInput({ onResolve, disabled, submitting }: ControlProps): ReactElement {
  return (
    <Row gap="sm" wrap>
      {submitting && <Spinner size="sm" label="Submitting…" />}
      <Button
        variant="primary"
        size="sm"
        disabled={disabled}
        onClick={() => {
          void onResolve({ kind: 'submit', payload: true });
        }}
      >
        Yes
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => {
          void onResolve({ kind: 'submit', payload: false });
        }}
      >
        No
      </Button>
    </Row>
  );
}

function ChoicesInput({
  item,
  onResolve,
  disabled,
  submitting,
  values,
}: ControlProps & { values: unknown[] }): ReactElement {
  const submitPrefix = item.uiHints?.submitLabel ?? '';
  return (
    <Column gap="sm">
      {submitting && <Spinner size="sm" label="Submitting…" />}
      <Row gap="sm" wrap>
        {values.map((value, idx) => {
          const label = typeof value === 'string' ? value : JSON.stringify(value);
          return (
            <Button
              key={`${idx}:${label}`}
              variant={idx === 0 ? 'primary' : 'secondary'}
              size="sm"
              disabled={disabled}
              onClick={() => {
                void onResolve({ kind: 'submit', payload: value });
              }}
            >
              {submitPrefix && idx === 0 ? `${submitPrefix}: ${label}` : label}
            </Button>
          );
        })}
      </Row>
    </Column>
  );
}

function StructuredInput({
  item,
  onResolve,
  disabled,
  submitting,
  schema,
}: ControlProps & { schema: Record<string, unknown> }): ReactElement {
  // Local state — the form is controlled, and submit gating reads
  // the validity callback. The initial value is `undefined` so the
  // form starts empty; required fields keep submit disabled until
  // they're populated.
  const [value, setValue] = useState<unknown>(undefined);
  const [valid, setValid] = useState(false);
  const submitLabel = item.uiHints?.submitLabel ?? 'Submit';
  return (
    <Column gap="sm">
      <SchemaForm
        schema={schema}
        value={value}
        onChange={setValue}
        onValidityChange={setValid}
        disabled={disabled}
      />
      <Row gap="sm" align="center">
        {submitting && <Spinner size="sm" label="Submitting…" />}
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || !valid}
          onClick={() => {
            void onResolve({ kind: 'submit', payload: value });
          }}
        >
          {submitLabel}
        </Button>
      </Row>
    </Column>
  );
}

function FreeFormInput({ item, onResolve, disabled, submitting }: ControlProps): ReactElement {
  const [value, setValue] = useState('');
  const submitLabel = item.uiHints?.submitLabel ?? 'Submit';
  return (
    <Column gap="sm">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        placeholder="Your response"
        disabled={disabled}
        rows={3}
        style={textareaStyle}
        aria-label="Response"
      />
      <Row gap="sm" align="center">
        {submitting && <Spinner size="sm" label="Submitting…" />}
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || value.trim().length === 0}
          onClick={() => {
            void onResolve({ kind: 'submit', payload: value });
          }}
        >
          {submitLabel}
        </Button>
      </Row>
    </Column>
  );
}

// ============================================================================
// Helpers
// ============================================================================

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: 'var(--space-2, 8px)',
  borderRadius: 'var(--radius-sm, 4px)',
  border: '1px solid var(--color-border-subtle, #d4d4d8)',
  background: 'var(--color-surface-1, #fff)',
  color: 'var(--color-text-primary, #111)',
  fontFamily: 'inherit',
  fontSize: '0.875rem',
  resize: 'vertical',
};

function prettyGateReason(reason: string): string {
  switch (reason) {
    case 'op_always_requires_approval':
      return 'op policy';
    case 'op_configurable_and_enabled':
      return 'op policy (configurable)';
    case 'binding_requires_approval':
      return 'binding policy';
    case 'capability_profile_gated':
      return 'capability profile';
    default:
      return reason;
  }
}
