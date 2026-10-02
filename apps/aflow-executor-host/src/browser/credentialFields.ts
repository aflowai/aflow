import type { EngineAction } from './types.js';

/**
 * The keys an agent may press on a credential field. None of them puts a
 * character into it, so they move, submit or clear without entering a
 * credential. Any other key, chord included, is refused: a list of keys that
 * do produce text would miss one, and a paste chord enters a whole value.
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

/** Whether the action puts a value into the field it is aimed at. */
export function entersValue(action: EngineAction): boolean {
  switch (action.kind) {
    case 'type':
    case 'select':
      return true;
    case 'press':
      return !CREDENTIAL_FIELD_KEYS.has(action.key);
    case 'click':
    case 'hover':
      return false;
  }
}
