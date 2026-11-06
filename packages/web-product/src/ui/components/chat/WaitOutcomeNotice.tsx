'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@aflow/design-system';
import { describeWaitOutcomeNotice } from './waitOutcomeLine.js';

/**
 * A wait the platform declared or held for the agent ended. The message is
 * the agent's instruction, so the chat folds it to one line for a person, and
 * the full text stays one keypress away for inspection.
 */
export function WaitOutcomeNotice({ body, timestamp }: { body: string; timestamp: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const spaceHeld = useRef(false);
  const toggle = () => {
    setExpanded((prev) => !prev);
  };
  // The keys toggle the notice here, as a button's activation does, and
  // cancel that activation, so a key toggles it once in every browser.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) toggle();
    } else if (event.key === ' ') {
      event.preventDefault();
      spaceHeld.current = true;
    }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ') return;
    event.preventDefault();
    if (!spaceHeld.current) return;
    spaceHeld.current = false;
    toggle();
  };
  return (
    <div className="chat-wait-notice" data-wait-notice={expanded ? 'expanded' : 'folded'}>
      <button
        type="button"
        className="chat-wait-notice__toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={toggle}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => {
          spaceHeld.current = false;
        }}
      >
        <Icon name="clock" size="xs" />
        <span className="chat-wait-notice__line">{describeWaitOutcomeNotice(body)}</span>
        {timestamp && <span className="chat-wait-notice__time">{timestamp}</span>}
        <Icon name={expanded ? 'caret-up' : 'caret-down'} size="xs" />
      </button>
      <div id={bodyId} className="chat-wait-notice__body" hidden={!expanded}>
        {body}
      </div>
    </div>
  );
}
