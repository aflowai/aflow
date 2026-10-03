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

/** What is read of a text field to tell whether it takes a credential: the element's own properties. */
export interface FieldAttributes {
  readonly tagName: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly inputMode: string;
  /** -1 where the field sets none, as the DOM reports it. */
  readonly maxLength: number;
}

/**
 * Runs in the page, so it is serialised on its own: it may reference nothing
 * outside itself and declares no inner function.
 */
export function readFieldAttributes(element: unknown): FieldAttributes {
  const field = element as {
    tagName?: unknown;
    type?: unknown;
    autocomplete?: unknown;
    inputMode?: unknown;
    maxLength?: unknown;
  };
  return {
    tagName: typeof field.tagName === 'string' ? field.tagName : '',
    type: typeof field.type === 'string' ? field.type : '',
    autocomplete: typeof field.autocomplete === 'string' ? field.autocomplete : '',
    inputMode: typeof field.inputMode === 'string' ? field.inputMode : '',
    maxLength: typeof field.maxLength === 'number' ? field.maxLength : -1,
  };
}

/** A password field: its value is never read off the machine, and no agent enters one. */
export function isMaskedField(field: FieldAttributes): boolean {
  return field.tagName === 'INPUT' && field.type.toLowerCase() === 'password';
}

const CREDENTIAL_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'one-time-code',
  'current-password',
  'new-password',
  'webauthn',
]);

/** One-time codes run to eight digits, and a code split one box per digit declares 1. */
const CODE_MAX_LENGTH = 8;

/**
 * Whether the field is where someone signing in enters something: a password,
 * a field the page marks for a code, a password or a passkey, or a short
 * numeric field, which is how most code pages that mark nothing still look.
 */
export function takesCredential(field: FieldAttributes): boolean {
  if (isMaskedField(field)) return true;
  const tokens = field.autocomplete.toLowerCase().split(/\s+/);
  if (tokens.some((token) => CREDENTIAL_AUTOCOMPLETE.has(token))) return true;
  return (
    field.inputMode.toLowerCase() === 'numeric' &&
    field.maxLength > 0 &&
    field.maxLength <= CODE_MAX_LENGTH
  );
}

/** Beyond this many text fields a page's remaining ones are taken as credential fields unchecked. */
export const MAX_TEXTBOXES_CHECKED = 200;

const TEXTBOX_REF = /^\s*- '?textbox\b[^\n]*?\[ref=([^\]\s]+)\]/gm;

export interface CredentialFields {
  readonly maskedRefs: Set<string>;
  readonly holdsCredentialField: boolean;
}

/**
 * Every text field the snapshot lists, read through `read`. A field that could
 * not be read, or one past the bound, is treated as the field it might be.
 */
export async function readCredentialFields(
  snapshotText: string,
  read: (ref: string) => Promise<FieldAttributes>,
): Promise<CredentialFields> {
  const maskedRefs = new Set<string>();
  let holdsCredentialField = false;
  const refs = [...snapshotText.matchAll(TEXTBOX_REF)].map((match) => match[1] ?? '');
  for (const [index, ref] of refs.entries()) {
    if (ref === '') continue;
    let field: FieldAttributes | undefined;
    if (index < MAX_TEXTBOXES_CHECKED) {
      try {
        field = await read(ref);
      } catch {
        field = undefined;
      }
    }
    if (field === undefined || isMaskedField(field)) maskedRefs.add(ref);
    if (field === undefined || takesCredential(field)) holdsCredentialField = true;
  }
  return { maskedRefs, holdsCredentialField };
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
