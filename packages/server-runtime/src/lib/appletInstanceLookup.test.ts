/**
 * The install path hydrates a view no executor ever compiled, so what it
 * writes is what the room mounts. These drive the real installed fixtures —
 * a React view (film, work-board) and a plain-DOM view (chess) — through the
 * same build the lookup runs, and hold it to the two things that make a view
 * render at all: a module the browser can parse, and every specifier in it
 * resolvable inside the sandbox.
 */
import { describe, expect, it } from 'vitest';
import {
  CHESS_VIEW_SOURCE,
  FILM_VIEW_SOURCE,
  WORK_BOARD_VIEW_SOURCE,
} from '@aflow/platform-artifacts';
import { decideAppletView, decodeLegacyInlineHtml } from './appletInstanceLookup.js';
import {
  buildAppletViewHtml,
  findUnpinnedExternalRef,
  validateAndCompile,
  wrapAppletHtml,
} from '@aflow/ui-artifact-compiler';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';

const VIEWS: Array<[string, string]> = [
  ['film', FILM_VIEW_SOURCE],
  ['work-board', WORK_BOARD_VIEW_SOURCE],
];

function moduleScript(html: string): string {
  const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return match![1]!;
}

function importMapOf(html: string): Record<string, string> {
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) return {};
  return (JSON.parse(match[1]!) as { imports?: Record<string, string> }).imports ?? {};
}

/** The compiler's own js loader is the parser — JSX fails it, plain JS does not. */
async function plainJsErrors(code: string): Promise<string[]> {
  const result = await validateAndCompile(code, 'html_js', [], []);
  return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

function inlineRef(html: string): string {
  return `inline:${Buffer.from(html, 'utf8').toString('base64')}`;
}

describe.each(VIEWS)('an installed %s view', (_name, source) => {
  it('does not parse as plain JS as it ships — it is TSX until something compiles it', async () => {
    expect(await plainJsErrors(source)).not.toEqual([]);
  });

  it('produces a module that parses as plain JS', async () => {
    const built = await buildAppletViewHtml(source, []);
    expect(built.shape).toBe('react_tsx');
    expect(built.html).not.toBeNull();
    expect(await plainJsErrors(moduleScript(built.html!))).toEqual([]);
  });

  it('resolves every bare specifier it carries inside the sandbox', async () => {
    const built = await buildAppletViewHtml(source, []);
    const imports = importMapOf(built.html!);
    // Minified output is one line with no space before the specifier
    // (`import R from"react";`), so the statement boundary is start-of-file,
    // a newline, or the previous statement's semicolon — never only a newline.
    const specifiers = [
      ...moduleScript(built.html!).matchAll(/(?:^|[\n;])\s*import\b[^'"]*['"]([^'"]+)['"]/g),
    ]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(imports[specifier]).toBeDefined();
    }
  });

  it('reaches no host the wrap did not pin', async () => {
    const built = await buildAppletViewHtml(source, []);
    expect(findUnpinnedExternalRef(built.html!)).toBeNull();
  });

  it('fits the inline ref the lookup persists', async () => {
    const built = await buildAppletViewHtml(source, []);
    expect(Buffer.byteLength(built.html!, 'utf8')).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
  });
});

describe('an installed chess view', () => {
  it('still wraps verbatim — a plain-DOM view needs no compiler', async () => {
    const built = await buildAppletViewHtml(CHESS_VIEW_SOURCE, []);
    expect(built.shape).toBe('plain_dom');
    expect(built.html).toBe(wrapAppletHtml(CHESS_VIEW_SOURCE, []));
    expect(await plainJsErrors(moduleScript(built.html!))).toEqual([]);
    expect(importMapOf(built.html!)).toEqual({});
    expect(findUnpinnedExternalRef(built.html!)).toBeNull();
    expect(Buffer.byteLength(built.html!, 'utf8')).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
  });
});

describe('why an applet has no view', () => {
  const inlineSource = (source: string) =>
    `inline:${Buffer.from(JSON.stringify(source), 'utf8').toString('base64')}`;

  it('hands back the ref already on the row without rebuilding', async () => {
    const decided = await decideAppletView({
      htmlRef: 'inline:YWxyZWFkeQ==',
      sourceRef: inlineSource('anything'),
      kind: 'applet',
    });
    expect(decided.htmlRef).toBe('inline:YWxyZWFkeQ==');
  });

  it('says a compile error is a compile error, in the compiler’s own words', async () => {
    const decided = await decideAppletView({
      htmlRef: null,
      sourceRef: inlineSource('export default function Broken() { return <div> }'),
      kind: 'applet',
    });
    // The diagnostics were collected and dropped before; a blank frame reading
    // "does not expose its view yet" sends the reader looking for a publish
    // step rather than at the syntax error they just wrote.
    expect(decided.unavailable?.reason).toBe('compile_failed');
    expect(decided.unavailable?.detail).toContain('did not compile');
    expect(decided.htmlRef).toBeUndefined();
  });

  it('has no size ceiling to report, because the view is stored rather than inlined', async () => {
    // A view used to be persisted as an inline ref and vanished past 64KB.
    // It is stored now, so a large view is simply a large view.
    const filler = 'x'.repeat(80_000);
    const decided = await decideAppletView({
      htmlRef: null,
      sourceRef: inlineSource(
        `export default function Big() { return React.createElement('div', null, '${filler}'); }`,
      ),
      kind: 'applet',
    });
    expect(decided.unavailable).toBeUndefined();
    expect((decided.html ?? '').length).toBeGreaterThan(80_000);
  });

  it('says an artifact that is not an applet is not one', async () => {
    const decided = await decideAppletView({
      htmlRef: null,
      sourceRef: inlineSource('anything'),
      kind: 'component',
    });
    expect(decided.unavailable?.reason).toBe('not_an_applet');
    expect(decided.unavailable?.detail).toContain('component');
  });

  it('says when the source cannot be read at all', async () => {
    const outside = await decideAppletView({
      htmlRef: null,
      sourceRef: 'gs://bucket/somewhere.json',
      kind: 'applet',
    });
    expect(outside.unavailable?.reason).toBe('source_unavailable');
  });

  it('reads a stored source through the loader the caller hands in', async () => {
    // A source past the inline cap lives in the payload store; the view path
    // compiles it the same as an inline one. The founding failure: the film
    // view crossed the cap, installed content-addressed, and every board
    // mounting it read "source outside the record".
    const decided = await decideAppletView(
      {
        htmlRef: null,
        sourceRef: 'tenants/t/content/abc123/artifact_source.json',
        kind: 'applet',
      },
      async () => `export default function Stored() { return React.createElement('div'); }`,
    );
    expect(decided.unavailable).toBeUndefined();
    // The compiled module is minified, so the proof is a built page, not a name.
    expect((decided.html ?? '').length).toBeGreaterThan(0);
  });

  it('a loader that cannot produce the source is a named refusal, not a crash', async () => {
    const missing = await decideAppletView(
      { htmlRef: null, sourceRef: 'tenants/t/content/abc123/artifact_source.json', kind: 'applet' },
      async () => null,
    );
    expect(missing.unavailable?.reason).toBe('source_unavailable');
    expect(missing.unavailable?.detail).toContain('could not be read back');

    const throwing = await decideAppletView(
      { htmlRef: null, sourceRef: 'tenants/t/content/abc123/artifact_source.json', kind: 'applet' },
      async () => {
        throw new Error('backend down');
      },
    );
    expect(throwing.unavailable?.reason).toBe('source_unavailable');
  });

  it('gives every refusal a reason and a detail, so none can render as silence', async () => {
    const refusals = await Promise.all([
      decideAppletView({ htmlRef: null, sourceRef: inlineSource('x'), kind: 'component' }),
      decideAppletView({ htmlRef: null, sourceRef: 'gs://b/x', kind: 'applet' }),
      decideAppletView({
        htmlRef: null,
        sourceRef: inlineSource('export default function B() { return <div> }'),
        kind: 'applet',
      }),
    ]);
    for (const refusal of refusals) {
      expect(refusal.unavailable?.reason).toBeTruthy();
      expect((refusal.unavailable?.detail ?? '').length).toBeGreaterThan(20);
    }
  });
});

describe('the rows written before views were stored', () => {
  it('decodes the legacy shape — base64 of the raw html, not JSON', () => {
    // The old writer inlined `Buffer.from(built.html).toString('base64')`;
    // the store's own codec JSON-encodes, so retrieve() throws on these. The
    // browser's decoder had a raw-string fallback; the server needs the same
    // or every view served before the migration 500s after it.
    const html = '<!doctype html><html><body>legacy</body></html>';
    const ref = `inline:${Buffer.from(html, 'utf8').toString('base64')}`;
    expect(decodeLegacyInlineHtml(ref)).toBe(html);
  });

  it('decodes the store-codec shape too — base64 of the JSON string', () => {
    const html = '<!doctype html><html><body>encoded</body></html>';
    const ref = `inline:${Buffer.from(JSON.stringify(html), 'utf8').toString('base64')}`;
    expect(decodeLegacyInlineHtml(ref)).toBe(html);
  });

  it('refuses what it cannot read instead of throwing', () => {
    expect(decodeLegacyInlineHtml('inline:')).toBeNull();
    expect(
      decodeLegacyInlineHtml(`inline:${Buffer.from('{"not":"a string"}').toString('base64')}`),
    ).toBeNull();
    expect(decodeLegacyInlineHtml('gs://bucket/not-inline')).toBeNull();
  });
});
