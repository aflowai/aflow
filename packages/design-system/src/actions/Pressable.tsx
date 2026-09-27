import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export interface PressableProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
}

/**
 * Unstyled clickable container. Use for custom interactive areas like
 * expandable headers, clickable cards, or any area that needs click
 * handling without button chrome.
 *
 * Renders a <button> for accessibility (focusable, keyboard-activatable)
 * but with all visual styling stripped. The component fills its container
 * width by default and uses flex layout so children compose naturally.
 */
export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(function Pressable(
  { style, children, type = 'button', ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    ...style,
  };

  return (
    <button ref={ref} type={type} style={s} {...rest}>
      {children}
    </button>
  );
});
