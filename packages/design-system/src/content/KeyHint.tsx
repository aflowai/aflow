/**
 * KeyHint — a keyboard key printed on the control it drives.
 *
 * A shortcut nobody can see is a shortcut nobody uses, so the binding rides
 * the button rather than a help screen. Renders `<kbd>`, which announces as a
 * key rather than as loose text.
 */
export interface KeyHintProps {
  /** The key as it is printed on the keyboard — a single key, not a sentence. */
  children: string;
  className?: string;
}

export function KeyHint({ children, className = '' }: KeyHintProps) {
  return <kbd className={['ds-key-hint', className].filter(Boolean).join(' ')}>{children}</kbd>;
}
