'use client';

/**
 * CommandLauncher — Universal `Cmd+K` command palette (DL-18, §10).
 *
 * Jumps to any Map node, opens any peek panel, or triggers any canonical
 * action from §10. Actions that don't exist yet are shown disabled with
 * a "Phase N" tooltip. Driven by an action registry.
 *
 * @example
 * ```tsx
 * <CommandLauncher
 *   open={launcherOpen}
 *   onClose={() => setLauncherOpen(false)}
 *   actions={consoleActions}
 *   onSelect={(action) => executeAction(action)}
 * />
 * ```
 */
import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import type { ConsoleAction } from '@aflow/schemas';
import { RegisterText } from './RegisterText.js';

export interface CommandLauncherProps {
  /** Whether the launcher is open. */
  open: boolean;
  /** Close handler. */
  onClose: () => void;
  /** Available actions. */
  actions: ConsoleAction[];
  /** Action selected handler. */
  onSelect: (action: ConsoleAction) => void;
}

export function CommandLauncher({ open, onClose, actions, onSelect }: CommandLauncherProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter actions by query
  const filtered = query
    ? actions.filter(
        (a) =>
          a.label.toLowerCase().includes(query.toLowerCase()) ||
          a.category.toLowerCase().includes(query.toLowerCase()),
      )
    : actions;

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected?.enabled) {
          onSelect(selected);
          onClose();
        }
      }
    },
    [filtered, selectedIndex, onClose, onSelect],
  );

  if (!open) return null;

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    zIndex: 'var(--z-modal)' as unknown as number,
    display: 'flex',
    justifyContent: 'center',
    paddingTop: '20vh',
  };

  const panelStyle: CSSProperties = {
    width: 520,
    maxHeight: '60vh',
    background: 'var(--color-cybernetic-raised)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: 'var(--shadow-xl)',
    animation: 'peek-slide-in var(--motion-snap-duration) var(--motion-snap-easing)',
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: 'var(--space-3) var(--space-4)',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid var(--color-border-subtle)',
    color: 'var(--color-cybernetic-ink)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'var(--font-family-sans)',
    outline: 'none',
  };

  // Group by category
  const categories = [...new Set(filtered.map((a) => a.category))];

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label="Command launcher"
    >
      <div style={panelStyle} onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          style={inputStyle}
          placeholder="Type a command..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          aria-label="Search commands"
        />

        <div style={{ overflow: 'auto', flex: 1 }}>
          {categories.map((category) => (
            <div key={category}>
              <div
                style={{
                  padding: 'var(--space-1) var(--space-4)',
                  fontSize: 'var(--font-size-xs)',
                  fontFamily: 'var(--font-family-system)',
                  color: 'var(--color-cybernetic-ink-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--font-letter-spacing-wider)',
                  marginTop: 'var(--space-2)',
                }}
              >
                {category}
              </div>
              {filtered
                .filter((a) => a.category === category)
                .map((action) => {
                  const globalIdx = filtered.indexOf(action);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={action.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        padding: 'var(--space-2) var(--space-4)',
                        background: isSelected ? 'var(--color-cybernetic-overlay)' : 'transparent',
                        cursor: action.enabled ? 'pointer' : 'not-allowed',
                        opacity: action.enabled ? 1 : 0.4,
                      }}
                      onClick={() => {
                        if (action.enabled) {
                          onSelect(action);
                          onClose();
                        }
                      }}
                      onMouseEnter={() => {
                        setSelectedIndex(globalIdx);
                      }}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={!action.enabled}
                      title={
                        !action.enabled && action.phaseHint
                          ? `Coming in ${action.phaseHint}`
                          : undefined
                      }
                    >
                      <RegisterText register="ui" size="sm" style={{ flex: 1 }}>
                        {action.label}
                      </RegisterText>

                      {action.shortcut && (
                        <RegisterText
                          register="system"
                          size="xs"
                          color="var(--color-cybernetic-ink-muted)"
                        >
                          {action.shortcut}
                        </RegisterText>
                      )}

                      {!action.enabled && action.phaseHint && (
                        <RegisterText
                          register="system"
                          size="xs"
                          color="var(--color-cybernetic-ink-muted)"
                        >
                          {action.phaseHint}
                        </RegisterText>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}

          {filtered.length === 0 && (
            <div
              style={{
                padding: 'var(--space-4)',
                textAlign: 'center',
                color: 'var(--color-cybernetic-ink-muted)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
