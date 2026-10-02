import type { EngineAction } from './types.js';

/**
 * The keys an agent may press on a credential field. None of them puts a
 * character into it, so they move, submit or clear without entering a
 * credential. Any other key is refused: a list of keys that do produce text
 * would miss one, and a paste chord enters a whole value.
 */
export const CREDENTIAL_FIELD_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
]);

/** Held with a key that enters nothing, these enter nothing either. */
export const MODIFIERS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** An allowed key alone, or held with modifiers only: `Shift+Tab`, never `Shift+A`. */
export function allowedOnCredentialField(key: string): boolean {
  const parts = key.split('+');
  const last = parts.pop();
  return (
    last !== undefined &&
    CREDENTIAL_FIELD_KEYS.has(last) &&
    parts.every((part) => MODIFIERS.has(part))
  );
}

/** Whether the action puts a value into the field it is aimed at. */
export function entersValue(action: EngineAction): boolean {
  switch (action.kind) {
    case 'type':
    case 'select':
      return true;
    case 'press':
      return !allowedOnCredentialField(action.key);
    case 'click':
    case 'hover':
      return false;
  }
}
