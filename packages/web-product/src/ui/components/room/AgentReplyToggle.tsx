'use client';

import { Icon, MenuItem, ToggleChip, Tooltip } from '@aflow/design-system';

const ON_HINT = 'The agent will answer. Turn off to talk to the room only.';
const OFF_HINT = 'Talking to the room. The agent reads this the next time it runs.';

/**
 * Whether the agent answers what you send.
 *
 * On by default and meant to stay that way — the exception is a team working
 * something out between themselves before anyone asks the agent to act, so
 * turning it off is the deliberate move, not the resting state. It sits with
 * the send-side controls rather than the agent knobs, because it changes what
 * pressing send does and nothing else.
 */
export function AgentReplyToggle({
  agentReplies,
  onChange,
  variant = 'chip',
}: {
  agentReplies: boolean;
  onChange: (next: boolean) => void;
  /** `chip` sits in the composer's action bar; `menu-item` is a row in its overflow menu. */
  variant?: 'chip' | 'menu-item';
}) {
  if (variant === 'menu-item') {
    return (
      <MenuItem
        icon={<Icon name="robot" size="sm" />}
        label="Agent replies"
        description={agentReplies ? ON_HINT : OFF_HINT}
        trailing={agentReplies ? 'On' : 'Off'}
        aria-pressed={agentReplies}
        onClick={() => {
          onChange(!agentReplies);
        }}
      />
    );
  }

  return (
    <Tooltip content={agentReplies ? ON_HINT : OFF_HINT} side="top" wrap>
      {/* Icon-only: there is no phrase for this shorter than the picture, and
          every phrase tried so far ("just talking") raised the question "to
          whom?". */}
      <ToggleChip
        active={!agentReplies}
        onClick={() => {
          onChange(!agentReplies);
        }}
        aria-label={agentReplies ? 'Agent will answer' : 'Agent will not answer'}
        aria-pressed={!agentReplies}
        icon={
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            {/* The same agent mark used everywhere else, so the agent is one
                recognisable thing across the app. It is a flat fill, so when
                it is switched off it recedes to muted and the stroke — not the
                glyph — carries the state. */}
            <Icon
              name="robot"
              size="xs"
              color={agentReplies ? 'var(--color-content-secondary)' : 'var(--color-content-muted)'}
            />
            {/* Drawn, because the set has no slashed robot. */}
            {!agentReplies ? (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -1,
                  right: -1,
                  top: '50%',
                  height: 1.5,
                  borderRadius: 1,
                  background: 'var(--color-warning-default)',
                  transform: 'rotate(-45deg)',
                }}
              />
            ) : null}
          </span>
        }
      />
    </Tooltip>
  );
}
