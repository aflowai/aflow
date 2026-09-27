/**
 * The composer's voice button is served by a route only the enterprise edition
 * composes (`/voice/token`). A community-local process registers none, so
 * rendering it there produces a control that deterministically 404s — worse
 * than a control that was never offered.
 *
 * The shell's sign-out gate is the same invariant, guarded beside it in
 * `editionGatedShell.test.ts`.
 *
 * This reads source because the invariant is about what the tree renders and
 * the app carries no renderable test surface: the chat page pulls the whole run
 * pipeline in behind it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHAT_PAGE_SRC = readFileSync(resolve(__dirname, '../screens/space-chat.tsx'), 'utf8');

/**
 * The braced expression that starts at `marker`, matched by depth so the guard
 * survives reformatting rather than pinning line breaks.
 */
function blockFrom(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `gate marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces from gate marker: ${marker}`);
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const VOICE_PROPS = [
  'voiceState',
  'voiceIsSpeaking',
  'voiceError',
  'onVoiceConnect',
  'onVoiceDisconnect',
  'voiceMicMode',
  'onVoiceMicModeChange',
  'onVoiceMicToggle',
  'voiceMicEnabled',
];

describe('voice control — space chat page', () => {
  it('reads the gate from the server-composed surface registry', () => {
    expect(CHAT_PAGE_SRC).toContain("useHasSurface('voice')");
  });

  it('passes every voice prop only inside that gate', () => {
    const gate = blockFrom(CHAT_PAGE_SRC, '{...(hasVoiceSurface');
    for (const prop of VOICE_PROPS) {
      const inGate = countOf(gate, prop);
      expect(inGate, `${prop} is not passed inside the voice-surface gate`).toBeGreaterThan(0);
      expect(
        countOf(CHAT_PAGE_SRC, prop),
        `${prop} also reaches the composer outside the voice-surface gate`,
      ).toBe(inGate);
    }
  });

  it('offers no connect callback, so the session hook never reaches the network', () => {
    // `useVoiceSession` mounts unconditionally — hooks cannot be called in a
    // branch — and holds idle state until `connect` runs. Withholding the
    // callback is therefore what keeps it dormant.
    const gate = blockFrom(CHAT_PAGE_SRC, '{...(hasVoiceSurface');
    expect(gate).toContain('voice.connect()');
    expect(countOf(CHAT_PAGE_SRC, 'voice.connect()')).toBe(1);
  });
});
