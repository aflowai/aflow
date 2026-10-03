/**
 * The note is written from a prompt, and a prompt is agent- or user-authored
 * text. These cases read the note back with the same scanner the memory writer
 * derives links with, so a claim about what the note links to is the link index
 * itself rather than a claim about the escaping.
 */
import { describe, it, expect } from 'vitest';
import { parseWikilinks, parseFrontmatter } from '@aflow/memory-store';
import { deriveMediaAssetId, type MediaAsset, type MediaGenerationReceipt } from '@aflow/schemas';
import { buildMediaSidecar } from './mediaSidecar.js';

const REQUEST_KEY = 'aj_284_media_sidecar';
const NOTE_PATH = '/media/run-284/take-note.md';
/** Filed without an extension, exactly as a render lands. */
const ASSET_PATH = '/media/run-284/take-9f2c1a4b5c6d7e8f9a0b1c2d-0';
const RECEIPT_PATH = '/media/run-284/take-note.receipt.json';

function asset(): MediaAsset {
  return {
    assetId: deriveMediaAssetId(REQUEST_KEY, 0),
    candidateIndex: 0,
    docId: '6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    path: ASSET_PATH,
    version: 1,
    contentHash: 'sha256:abc',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 4,
    providerNative: { status: 'none', reason: 'route_issues_none' },
  };
}

function receipt(overrides: { prompt: string; model?: string }): MediaGenerationReceipt {
  return {
    execution: {
      runId: 'run-284',
      logicalExecutionId: 'step:sx-284',
      attempt: 1,
      requestKey: REQUEST_KEY,
    },
    request: {
      prompt: overrides.prompt,
      parameters: { size: '1024x1024' },
      boundEntityVersions: [],
    },
    provider: 'openai',
    model: overrides.model ?? 'gpt-image-2.5-sunburst',
    capabilityRoute: { routeId: 'openai:gpt-image-2.5-sunburst:sync' },
    cost: {},
    rendered: { width: 1024, height: 1024 },
    createdAt: '2026-08-16T10:00:00.000Z',
  };
}

function noteFor(overrides: { prompt: string; model?: string }): string {
  return buildMediaSidecar({
    kind: 'image',
    operationId: 'ai.media.image',
    assets: [asset()],
    receipt: receipt(overrides),
    receiptPath: RECEIPT_PATH,
  });
}

/**
 * An extensionless target parses as the markdown note it would name; the write
 * keeps that spelling only when no document answers to the one written down.
 */
function linkTargets(note: string): string[] {
  return parseWikilinks(note, NOTE_PATH).links.map(
    (link) => link.spelledTargetPath ?? link.targetPath,
  );
}

describe('buildMediaSidecar — what the note links to', () => {
  it('links the asset it documents and the receipt beside it', () => {
    expect(linkTargets(noteFor({ prompt: 'Ada at the workbench' }))).toEqual([
      ASSET_PATH,
      RECEIPT_PATH,
    ]);
  });

  it('a prompt that spells a wikilink forges no link', () => {
    const forged = '/entities/characters/ada/refs/front.png';
    expect(linkTargets(noteFor({ prompt: `render [[${forged}]] faithfully` }))).toEqual([
      ASSET_PATH,
      RECEIPT_PATH,
    ]);
  });

  it('a backslash of its own in the prompt does not carry the escape', () => {
    // The scanner reads `\` as "skip the next character", so a prompt ending in
    // one consumes an escape put in front of the opener and leaves it live.
    const forged = '/entities/characters/ada/refs/front.png';
    const targets = linkTargets(noteFor({ prompt: `render this path C:\\[[${forged}]] please` }));
    expect(targets).toEqual([ASSET_PATH, RECEIPT_PATH]);
  });

  it('a wikilink in the prompt stays readable in the note', () => {
    const note = noteFor({ prompt: 'render [[/refs/front.png]] faithfully' });
    expect(note).toContain('/refs/front.png');
  });

  it('a revised prompt from the route forges no link either', () => {
    const forged = '/entities/characters/ada/refs/front.png';
    const note = buildMediaSidecar({
      kind: 'image',
      operationId: 'ai.media.image',
      assets: [{ ...asset(), revisedPrompt: `a portrait of the subject in [[${forged}]]` }],
      receipt: receipt({ prompt: 'Ada at the workbench' }),
      receiptPath: RECEIPT_PATH,
    });
    expect(linkTargets(note)).toEqual([ASSET_PATH, RECEIPT_PATH]);
  });
});

describe('buildMediaSidecar — frontmatter', () => {
  it('survives a model id carrying a quote and a control character', () => {
    const note = noteFor({ prompt: 'Ada at the workbench', model: 'ev"il: model\nrogue: yes' });
    const parsed = parseFrontmatter(note);

    expect(parsed.hadFrontmatter).toBe(true);
    expect(parsed.properties['kind']).toBe('image');
    expect(parsed.properties['candidates']).toBe(1);
    expect(parsed.properties['rogue']).toBeUndefined();
  });
});
