'use client';

import {
  useState,
  useRef,
  useEffect,
  type FormEvent,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { StopIcon } from '@phosphor-icons/react/dist/csr/Stop';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { AnimatedHeight } from './AnimatedHeight.js';

export interface ChatComposerProps {
  /** Placeholder text. Empty by default — the composer reads as a place to
   *  type without being told. */
  placeholder?: string;
  /** Called when message is submitted */
  onSubmit: (message: string) => void;
  /** Whether submission is in progress */
  loading?: boolean;
  /** Disable the composer */
  disabled?: boolean;
  /** Auto-focus on mount */
  autoFocus?: boolean;
  /** Maximum rows before scrolling */
  maxRows?: number;
  /** Additional class name */
  className?: string;
  /**
   * Editable text to load into the composer (e.g. a Workbench quick-start
   * template). Applied whenever `seedNonce` changes — bump the nonce to
   * re-apply the same text — so it never fights the user's own typing.
   */
  seedValue?: string;
  seedNonce?: number;
  /**
   * Called as the person types. Used to tell others in a shared room that
   * someone is composing — fires per keystroke, so the consumer is expected
   * to throttle rather than send on each one.
   */
  onTyping?: () => void;
  /** Control pinned inside the pill ahead of the input (e.g. an overflow menu). */
  leading?: ReactNode;
  /** Control pinned inside the pill between the input and the send button. */
  trailing?: ReactNode;
}

/**
 * Whether the engine grows a textarea to fit its content on its own.
 *
 * Where it does, the JS fallback below is not merely redundant — it is the
 * expensive path. Measuring a textarea means writing a height and reading
 * `scrollHeight` back, and that read forces the browser to lay out the whole
 * document synchronously, so on a long session every keystroke re-lays out all
 * the history behind the composer.
 *
 * Evaluated once: support cannot change while the document is open.
 */
const NATIVE_FIELD_SIZING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

export function ChatComposer({
  placeholder = '',
  onSubmit,
  loading = false,
  disabled = false,
  autoFocus = false,
  maxRows = 5,
  className = '',
  seedValue,
  seedNonce,
  onTyping,
  leading,
  trailing,
}: ChatComposerProps) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isMobile = useMediaQuery('(max-width: 639px)');

  // Prefill: apply on every nonce change, place the cursor at the end, focus,
  // and resize to fit. Guarded on the nonce so re-renders don't clobber typing.
  const lastSeedNonceRef = useRef(seedNonce);
  useEffect(() => {
    if (seedNonce === undefined || lastSeedNonceRef.current === seedNonce) return;
    lastSeedNonceRef.current = seedNonce;
    const next = seedValue ?? '';
    setValue(next);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.length, next.length);
      if (NATIVE_FIELD_SIZING) {
        // The engine sizes the field from its content. A pixel height written
        // here would stick — the input handler returns early under native
        // sizing and never clears it — leaving a seeded composer frozen at
        // whatever the seed measured, growing and shrinking for nobody.
        ta.style.height = '';
        return;
      }
      ta.style.height = 'auto';
      ta.style.height = `${String(ta.scrollHeight)}px`;
    });
  }, [seedNonce, seedValue]);

  // Re-focus textarea whenever the composer becomes enabled
  // (covers: loading finishes, run pauses awaiting input, etc.)
  const prevDisabledRef = useRef(disabled);
  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    const wasUnavailable = prevDisabledRef.current || prevLoadingRef.current;
    const isNowAvailable = !disabled && !loading;
    if (wasUnavailable && isNowAvailable) {
      textareaRef.current?.focus();
    }
    prevDisabledRef.current = disabled;
    prevLoadingRef.current = loading;
  }, [disabled, loading]);

  // Restart the squash-and-stretch even when it's still playing from the
  // previous send: the class has to leave the element and a layout be forced
  // before it goes back on, or the browser keeps the running animation.
  const playSendElastic = () => {
    const form = formRef.current;
    if (!form) return;
    form.classList.remove('ds-chat-composer--sent');
    void form.offsetWidth;
    form.classList.add('ds-chat-composer--sent');
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (trimmed && !loading && !disabled) {
      onSubmit(trimmed);
      setValue('');
      playSendElastic();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      // Immediately re-focus the textarea
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /**
   * Grow the box to fit what has been typed.
   *
   * Writing a height and then reading `scrollHeight` forces the browser to lay
   * the page out synchronously, and that cost is the whole document's, not the
   * textarea's — on a long session the composer ends up re-laying out every
   * event card on screen, once per keystroke.
   *
   * So the measurement happens once per frame rather than once per key, and the
   * line height is read once rather than every time: `getComputedStyle` is a
   * second forced recalculation, and the value cannot change between keystrokes
   * without a resize or a font swap, both of which remount this anyway.
   */
  const resizeFrameRef = useRef<number | null>(null);
  const lineHeightRef = useRef<number | null>(null);

  const handleInput = () => {
    // Nothing to do where the engine sizes the field itself.
    if (NATIVE_FIELD_SIZING) return;
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;
      lineHeightRef.current ??= parseInt(getComputedStyle(textarea).lineHeight);
      const effectiveMaxRows = isMobile ? Math.min(maxRows, 3) : maxRows;
      const maxHeight = (lineHeightRef.current || 0) * effectiveMaxRows;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    });
  };

  useEffect(
    () => () => {
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    },
    [],
  );

  const containerStyle: CSSProperties = isMobile
    ? {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '4px 6px',
        backgroundColor: 'var(--color-surface-3)',
        backdropFilter: 'blur(14px)',
        borderRadius: 'var(--radius-full)',
        border: '1px solid var(--color-border-default)',
        boxShadow: 'var(--shadow-sm)',
      }
    : {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-2) var(--space-2)',
        backgroundColor: 'var(--color-surface-0)',
        borderRadius: 'var(--radius-lg) var(--radius-lg)',
        margin: 'var(--space-1) var(--space-1)',
      };

  const textareaStyle: CSSProperties = {
    flex: 1,
    resize: 'none',
    // Sizes the field from its content in the engine, which is the same growth
    // the fallback below computes by hand — minus the forced layout. Ignored by
    // browsers that do not know it, which is what `NATIVE_FIELD_SIZING` detects.
    ...({ fieldSizing: 'content' } as CSSProperties),
    minHeight: isMobile ? '36px' : '38px',
    // 16px text on mobile keeps iOS from auto-zooming the focused composer
    maxHeight: `${(isMobile ? Math.min(maxRows, 3) : maxRows) * (isMobile ? 24 : 22)}px`,
    padding: isMobile ? '6px 8px' : '12px',
    fontSize: isMobile ? '16px' : 'var(--font-size-base)',
    lineHeight: 'var(--font-line-height-normal)',
    color: disabled ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: isMobile
      ? 'none'
      : `0px solid ${disabled ? 'var(--color-border-default)' : 'var(--color-border-strong)'}`,
    outline: 'none',
    fontFamily: 'inherit',
    scrollbarWidth: 'none',
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? 'default' : 'text',
    transition:
      'border-color var(--transition-duration-fast) var(--transition-timing-default), box-shadow var(--transition-duration-fast) var(--transition-timing-default), color 200ms ease, opacity 200ms ease',
  };

  const canSubmit = value.trim().length > 0 && !loading && !disabled;

  const buttonSize = '36px';
  const sendButtonStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: buttonSize,
    height: buttonSize,
    borderRadius: 'var(--radius-round)',
    border: 'none',
    cursor: loading ? 'default' : canSubmit ? 'pointer' : 'not-allowed',
    transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: loading
      ? 'var(--color-interactive-default)'
      : canSubmit
        ? 'var(--color-interactive-default)'
        : 'var(--color-border-strong)',
    color: canSubmit || loading ? 'var(--color-text-inverse)' : 'var(--color-text-muted)',
    flexShrink: 0,
    opacity: !canSubmit && !loading ? 0.5 : 1,
  };

  return (
    <AnimatedHeight className={className}>
      <form
        ref={formRef}
        className="ds-chat-composer"
        data-focused={focused ? 'true' : undefined}
        style={containerStyle}
        onSubmit={handleSubmit}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && e.animationName === 'ds-composer-elastic') {
            e.currentTarget.classList.remove('ds-chat-composer--sent');
          }
        }}
      >
        {leading}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            onTyping?.();
          }}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-interactive-default)';
            setFocused(true);
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border-default)';
            setFocused(false);
          }}
          placeholder={placeholder}
          readOnly={disabled}
          autoFocus={autoFocus}
          rows={1}
          style={textareaStyle}
          className="ds-chat-composer-input"
          aria-label="Message input"
        />
        {trailing}
        <button
          type="submit"
          className="ds-chat-composer__send"
          disabled={!canSubmit && !loading}
          aria-label={loading ? 'Sending...' : 'Send message'}
          style={sendButtonStyle}
        >
          {loading ? (
            <span className="ds-send-pulse" aria-hidden="true">
              <StopIcon size={isMobile ? 12 : 14} weight="fill" />
            </span>
          ) : (
            <ArrowUpIcon size={isMobile ? 14 : 16} weight="bold" />
          )}
        </button>
      </form>
    </AnimatedHeight>
  );
}
