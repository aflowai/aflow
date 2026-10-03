/**
 * Tests for buildToolResultSummary — the agent-visible output summary builder.
 *
 * Key concern: internal ref fields (dataRef, bodyRef, contentRef) must NEVER
 * appear in agent-visible summaries. Agents copy these and use them incorrectly.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AiMediaOutputSchema,
  deriveMediaAssetId,
  TOOL_RESULT_INLINE_MAX_CHARS,
  type AiMediaOutput,
} from '@aflow/schemas';
import { buildToolResultSummary, buildToolResultSummaryWithMeta } from './outputSummary.js';

const RUN_ID = 'run-01K9ZH3Q7VYQ8B2C4D6E8F0G2H';
const REQUEST_KEY = createHash('sha256').update('one-provider-request').digest('hex');

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function docUuid(index: number): string {
  const h = hash(`doc-${String(index)}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A render as the media operations actually return it, validated by the output
 * schema so the fixture cannot drift from the contract it is standing in for.
 */
function padPath(path: string, toChars: number | undefined): string {
  return toChars === undefined ? path : path.padEnd(toChars, 'x');
}

function mediaOutput(opts: {
  candidates: number;
  references: number;
  promptChars: number;
  revisedPromptChars?: number;
  pathChars?: number;
}): AiMediaOutput {
  const assets = Array.from({ length: opts.candidates }, (_, index) => {
    const assetId = deriveMediaAssetId(REQUEST_KEY, index);
    return {
      assetId,
      candidateIndex: index,
      docId: docUuid(index),
      path: padPath(`/media/${RUN_ID}/take-${assetId}`, opts.pathChars),
      version: 1,
      contentHash: hash(`bytes-${String(index)}`),
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 3_214_567 + index,
      ...(opts.revisedPromptChars !== undefined
        ? { revisedPrompt: 'R'.repeat(opts.revisedPromptChars) }
        : {}),
      providerNative: { status: 'none', reason: 'route_issues_none' },
    };
  });
  const stem = deriveMediaAssetId(REQUEST_KEY, 0).split('-')[0] ?? '';
  return AiMediaOutputSchema.parse({
    assets,
    receipt: {
      execution: {
        runId: RUN_ID,
        logicalExecutionId: 'se-01K9ZH3Q7VYQ8B2C4D6E8F0G2J',
        attempt: 0,
        requestKey: REQUEST_KEY,
        providerJobId: 'projects/aflowai/operations/12345678-abcd',
      },
      request: {
        prompt: 'P'.repeat(opts.promptChars),
        parameters: { durationSeconds: 8, aspectRatio: '16:9', resolution: '1080p' },
        boundEntityVersions: Array.from({ length: opts.references }, (_, index) => ({
          path: padPath(`/characters/atlas/reference-${String(index)}.png`, opts.pathChars),
          version: 3,
          contentHash: hash(`reference-${String(index)}`),
          role: 'character',
          label: `atlas-${String(index)}`,
        })),
      },
      provider: 'google',
      model: 'veo-3.1-generate-preview',
      capabilityRoute: { routeId: 'google/veo-3.1/async', requestedModel: 'veo-3.1' },
      cost: {
        quoted: { currency: 'USD', micros: 3_200_000 },
        actual: { currency: 'USD', micros: 3_200_000 },
      },
      rendered: { width: 1920, height: 1080, durationSeconds: 8.04 },
      createdAt: '2026-08-16T10:11:12.000Z',
    },
    receiptRef: {
      path: `/media/${RUN_ID}/take-${stem}.receipt.json`,
      version: 1,
      contentHash: hash('receipt'),
    },
  });
}

function expectEveryPin(summary: string, output: AiMediaOutput): void {
  const parsed = JSON.parse(summary) as AiMediaOutput;
  expect(parsed.assets).toHaveLength(output.assets.length);
  for (const [index, asset] of output.assets.entries()) {
    const shown = parsed.assets[index];
    expect(shown?.path).toBe(asset.path);
    expect(shown?.version).toBe(asset.version);
    expect(shown?.contentHash).toBe(asset.contentHash);
    expect(shown?.assetId).toBe(asset.assetId);
    expect(shown?.docId).toBe(asset.docId);
  }
  expect(parsed.receiptRef).toEqual(output.receiptRef);
}

describe('buildToolResultSummary', () => {
  // ── Internal ref stripping ────────────────────────────────────────────

  describe('strips internal ref fields from small passthrough outputs', () => {
    it('removes dataRef from memory get output', () => {
      const output = {
        stat: { path: '/data/train.csv', sizeBytes: 100 },
        data: 'Id,MSSubClass\n1,60',
        dataRef: 'gs://redis-store/tenants/abc/runs/def/steps/ghi/attempt/1/body.json',
        truncated: true,
      };
      const summary = buildToolResultSummary(output, 'tool-123');
      expect(summary).not.toContain('dataRef');
      expect(summary).not.toContain('gs://');
      expect(summary).toContain('data'); // the actual data field should remain
    });

    it('removes bodyRef from API output', () => {
      const output = {
        statusCode: 200,
        data: '{"result": "ok"}',
        bodyRef: 'gs://bucket/path/body.json',
      };
      const summary = buildToolResultSummary(output, 'tool-456');
      expect(summary).not.toContain('bodyRef');
      expect(summary).not.toContain('gs://bucket');
    });

    it('removes rawBodyRef (untransformed response text handle) from API output', () => {
      const output = {
        statusCode: 200,
        data: { papers: [{ arxivId: '1706.03762v7' }] },
        rawBodyRef: 'gs://bucket/raw_body.json',
        parsedMeta: { contentType: 'application/json', sourceContentType: 'application/atom+xml' },
      };
      const summary = buildToolResultSummary(output, 'tool-arxiv');
      expect(summary).not.toContain('rawBodyRef');
      expect(summary).not.toContain('gs://bucket/raw_body.json');
      expect(summary).toContain('arxivId');
    });

    it('removes contentRef from output', () => {
      const output = {
        stat: { path: '/file.txt', sizeBytes: 50 },
        data: 'hello',
        contentRef: 'gs://bucket/path/content.json',
      };
      const summary = buildToolResultSummary(output, 'tool-789');
      expect(summary).not.toContain('contentRef');
      expect(summary).not.toContain('gs://bucket');
    });

    it('preserves all other fields', () => {
      const output = {
        id: 'doc-123',
        path: '/data/file.csv',
        version: 3,
        sizeBytes: 100,
        data: 'content here',
        dataRef: 'gs://should-be-stripped',
      };
      const summary = buildToolResultSummary(output, 'tool-abc');
      expect(summary).toContain('doc-123');
      expect(summary).toContain('/data/file.csv');
      expect(summary).toContain('content here');
      expect(summary).not.toContain('gs://should-be-stripped');
    });
  });

  it('passes through small outputs without internal refs unchanged', () => {
    const output = { exitCode: 0, data: 'hello', stderr: '' };
    const summary = buildToolResultSummary(output, 'tool-simple');
    expect(summary).toContain('"exitCode":0');
    expect(summary).toContain('"data":"hello"');
  });

  // ── Shaped summaries ────────────────────────────────────────────────

  it('builds compute summary with virtual path for large output', () => {
    // Each line is short so firstLines(5) keeps the preview small,
    const output = {
      exitCode: 0,
      data: Array.from({ length: 200 }, (_, i) => `line ${String(i)}: ${'x'.repeat(80)}`).join(
        '\n',
      ),
      stderr: '',
      durationMs: 1500,
    };
    const summary = buildToolResultSummary(output, 'compute-123');
    expect(summary).toContain('[Compute exit 0');
    expect(summary).toContain('/run/outputs/compute-123/data');
    expect(summary).not.toContain('dataRef');
    expect(summary).not.toContain('To visualize:');
  });

  it('builds memory summary with virtual path for large output', () => {
    const output = {
      stat: { path: '/data/train.csv', sizeBytes: 460000, mimeType: 'text/csv' },
      data: Array.from({ length: 200 }, (_, i) => `row ${String(i)}: ${'x'.repeat(80)}`).join('\n'),
      truncated: true,
    };
    const summary = buildToolResultSummary(output, 'mem-456');
    expect(summary).toContain('[Memory /data/train.csv');
    expect(summary).toContain('/run/outputs/mem-456/data');
    expect(summary).not.toContain('To visualize:');
  });

  it('shows outputFiles with virtual filesystem paths (base64-encoded content)', () => {
    // outputFiles content is always base64-encoded by the compute executor
    const csvContent = Buffer.from('Id,SalePrice\n1461,120000').toString('base64');
    const output = {
      exitCode: 0,
      data: Array.from({ length: 200 }, (_, i) => `line ${String(i)}: ${'x'.repeat(80)}`).join(
        '\n',
      ),
      stderr: '',
      durationMs: 2000,
      outputFiles: {
        'submission.csv': csvContent,
      },
    };
    const summary = buildToolResultSummary(output, 'comp-789');
    expect(summary).toContain('submission.csv');
    expect(summary).toContain('/run/outputs/comp-789/outputFiles/submission.csv');
    // Agent should never see raw base64 content
    expect(summary).not.toContain(csvContent);
    expect(summary).not.toContain('To visualize:');
  });

  // ── Generated media (pinned assets + receipt) ───────────────────────

  describe('generated media', () => {
    it('passes a small render through whole', () => {
      const output = mediaOutput({ candidates: 1, references: 1, promptChars: 200 });
      const { text, meta } = buildToolResultSummaryWithMeta(output, 'vid-000');
      expect(meta.kind).toBe('passthrough');
      expect(JSON.parse(text)).toEqual(output);
    });

    it('keeps every pin of a reference-heavy render whose prompt crosses the threshold', () => {
      const output = mediaOutput({ candidates: 10, references: 8, promptChars: 6_000 });
      const { text, meta } = buildToolResultSummaryWithMeta(output, 'vid-001');

      // Past the passthrough threshold: the raw output no longer reaches the
      // agent, so this is the summariser's own answer.
      expect(meta.kind).toBe('source_preview');
      expect(text).not.toContain('Large result');
      expectEveryPin(text, output);

      // The prompt is the bulk and the agent supplied it — it is what gives way.
      expect(text).not.toContain('P'.repeat(1_000));
      expect(text).toContain('receiptRef');
    });

    it('keeps every pin at the schema ceilings for prompt, references and revisions', () => {
      const output = mediaOutput({
        candidates: 10,
        references: 8,
        promptChars: 32_000,
        revisedPromptChars: 32_000,
      });
      const { text, meta } = buildToolResultSummaryWithMeta(output, 'vid-002');

      expect(meta.kind).toBe('source_preview');
      expectEveryPin(text, output);
      // Under the hard cap, whose tail truncation would cut the JSON mid-token.
      expect(text.length).toBeLessThan(12_000);
      const parsed = JSON.parse(text) as { note?: string };
      expect(parsed.note).toContain('receiptRef');
    });

    it('gives up candidates and bound pins before it shortens one asset identity', () => {
      // Every length at the schema's own ceiling: 1024-char paths, 32 bound
      // documents, a 32,000-char prompt.
      const output = mediaOutput({
        candidates: 10,
        references: 32,
        promptChars: 32_000,
        pathChars: 1_024,
      });
      const { text, meta } = buildToolResultSummaryWithMeta(output, 'vid-004');

      expect(meta.kind).toBe('source_preview');
      expect(text.length).toBeLessThan(12_000);
      const parsed = JSON.parse(text) as AiMediaOutput & { note?: string };

      expect(parsed.assets.length).toBeGreaterThan(0);
      expect(parsed.assets.length).toBeLessThan(output.assets.length);
      for (const [index, shown] of parsed.assets.entries()) {
        const asset = output.assets[index];
        expect(shown.path).toBe(asset?.path);
        expect(shown.version).toBe(asset?.version);
        expect(shown.contentHash).toBe(asset?.contentHash);
      }
      expect(parsed.receiptRef).toEqual(output.receiptRef);
      expect(parsed.receipt.request.boundEntityVersions).toBeUndefined();
      expect(parsed.note).toContain('candidates');
      expect(parsed.note).toContain('32 pins');
    });

    it('keeps the cost and the delivered format the receipt was written with', () => {
      const output = mediaOutput({ candidates: 4, references: 5, promptChars: 9_000 });
      const { text } = buildToolResultSummaryWithMeta(output, 'vid-003');
      const parsed = JSON.parse(text) as AiMediaOutput;
      expect(parsed.receipt.cost).toEqual(output.receipt.cost);
      expect(parsed.receipt.rendered).toEqual(output.receipt.rendered);
      expect(parsed.receipt.execution.requestKey).toBe(output.receipt.execution.requestKey);
    });
  });

  // ── Base64 sanitization in generic fallback ─────────────────────────

  it('sanitizes base64 blobs in generic output', () => {
    const output = {
      result: 'success',
      binaryBlob: 'A'.repeat(10_000), // looks like base64
    };
    const summary = buildToolResultSummary(output, 'gen-001');
    expect(summary).toContain('[base64 data,');
    expect(summary).not.toContain('A'.repeat(256));
  });

  it('Plan 184 §3.B — attaches a structural outline + pointer for large generic results', () => {
    const output = {
      workflow: { slug: 'kaggle', name: 'Kaggle Optimizer' },
      ledgerSummary: {
        totalRuns: 22,
        recentEntries: Array.from({ length: 22 }, (_, i) => ({
          runId: `run-${String(i)}`,
          status: 'completed',
          notes: 'x'.repeat(600), // pad past the inline budget so the generic path runs
        })),
      },
    };
    const summary = buildToolResultSummary(output, 'wf-get-1');
    // Header + structural pointer instead of a raw JSON dump.
    expect(summary).toContain('Large result');
    expect(summary).toContain('view: "outline"');
    expect(summary).toContain('/run/outputs/wf-get-1');
    // Outline shows shape (keys + array length) but not the row data.
    expect(summary).toContain('ledgerSummary');
    expect(summary).toContain('recentEntries: array[22]');
    expect(summary).not.toContain('x'.repeat(600));
  });

  it('Plan 184 §3.B — large scalar output gets a content preview + read hint, not an outline', () => {
    // A raw text blob over the inline budget routes through the generic path
    // as a scalar — the structural outline / jsonPath surface is useless here.
    const longText = Array.from({ length: 1000 }, (_, i) => `line ${String(i)} of the report`).join(
      '\n',
    ); // > 12KB passthrough threshold → generic (scalar) path
    const summary = buildToolResultSummary(longText, 'scalar-1');
    // Positional read hint, NOT the structural outline/jsonPath surface.
    expect(summary).toContain('view: "content"');
    expect(summary).toContain('lineRange');
    expect(summary).toContain('/run/outputs/scalar-1');
    expect(summary).not.toContain('view: "outline"');
    expect(summary).not.toContain('jsonPath');
    // The agent actually sees some of the text.
    expect(summary).toContain('Preview:');
    expect(summary).toContain('line 0 of the report');
  });

  it('sanitizes base64 in small passthrough outputs', () => {
    // Even small outputs should have base64 sanitized
    const output = {
      tiny: 'B'.repeat(300),
    };
    const summary = buildToolResultSummary(output, 'small-b64');
    expect(summary).toContain('[base64 data,');
    expect(summary).not.toContain('B'.repeat(256));
  });

  it('Plan 186 §5.E — surfaces output files even when stdout is small (no longer stripped to passthrough)', () => {
    // Pre-5.E this stripped `outputFiles` and passed the small remainder through,
    // so a step that PRODUCED a file surfaced no mention of it (the agent had to
    // guess the path — §2.2). Now a non-empty `outputFiles` routes through the
    // compute summary so the file path + the "return as output" affordance show.
    const pkl = Buffer.from('\x80\x04\x95').toString('base64');
    const output = {
      exitCode: 0,
      data: 'ok',
      stderr: '',
      outputFiles: { 'model.pkl': pkl },
    };
    const summary = buildToolResultSummary(output, 'comp-strip');
    expect(summary).toContain('[Compute exit 0');
    expect(summary).toContain('/run/outputs/comp-strip/outputFiles/model.pkl');
    // 5.C write-side affordance, using the file as the worked example.
    expect(summary).toContain('To return as your output');
    expect(summary).toContain('"$ref": "output.comp-strip/outputFiles/model.pkl"');
    // Raw base64 file content must never reach the agent.
    expect(summary).not.toContain(pkl);
  });

  describe('Plan 186 §5.C/§5.E — by-reference affordances', () => {
    it('§5.E — a small TRUNCATED api result still surfaces read/persist affordances (not a bare 1KB stub)', () => {
      // The §2.1 shape: api.http.call over 64 KB stores the full body to
      // `dataRef` and sets `data` to a ~1 KB preview + `truncated`/
      // `originalSizeBytes`. After stripping `dataRef` the remainder is tiny —
      // without §5.E it passes through as a 1-row stub with no pointer to the full body.
      const output = {
        statusCode: 200,
        data: 'Id,MSSubClass,LotArea\n1,60,8450\n…[truncated]',
        dataRef: 'gs://bucket/full-train.csv',
        truncated: true,
        originalSizeBytes: 460_000,
        contentType: 'text/csv',
      };
      const summary = buildToolResultSummary(output, 'api-trunc');
      // Routed through the builder despite the small post-strip size.
      expect(summary).toContain('[API 200');
      expect(summary).toContain('TRUNCATED');
      // Full size reported, not the ~1 KB preview length.
      expect(summary).toContain('449KB');
      // The read/persist affordances the agent needs to reach the full body.
      expect(summary).toContain('/run/outputs/api-trunc/data');
      expect(summary).toContain('memory.store.put(content: {fromPath:');
      // Never leaks the raw payload ref.
      expect(summary).not.toContain('gs://bucket/full-train.csv');
    });

    it('§5.C — compute output-file summary carries the "return as output" $ref affordance', () => {
      const csv = Buffer.from('Id,SalePrice\n1461,120000').toString('base64');
      const output = {
        exitCode: 0,
        data: 'wrote submission',
        stderr: '',
        outputFiles: { 'submission.csv': csv },
      };
      const summary = buildToolResultSummary(output, 'comp-ret');
      expect(summary).toContain('To return as your output');
      expect(summary).toContain('"$ref": "output.comp-ret/outputFiles/submission.csv"');
      expect(summary).toContain('do NOT read the value into your context first');
    });

    it('§5.C — large generic result carries the "return as output" $ref affordance', () => {
      const output = {
        report: {
          title: 'Q3',
          rows: Array.from({ length: 300 }, (_, i) => ({ i, v: 'x'.repeat(60) })),
        },
      };
      const summary = buildToolResultSummary(output, 'gen-ret');
      expect(summary).toContain('To return as your output');
      expect(summary).toContain('"$ref": "output.gen-ret"');
    });

    it('§5.E — a non-truncated result with a bare sibling ref still passes through (preserves sibling fields)', () => {
      // No truncated/originalSizeBytes/outputFiles → the inline data is the whole
      // value; passthrough is correct and must keep non-shape fields like `id`.
      const output = {
        id: 'doc-123',
        path: '/data/file.csv',
        version: 3,
        sizeBytes: 100,
        data: 'content here',
        dataRef: 'gs://should-be-stripped',
      };
      const summary = buildToolResultSummary(output, 'mem-keep');
      expect(summary).toContain('doc-123');
      expect(summary).toContain('content here');
      expect(summary).not.toContain('gs://should-be-stripped');
      expect(summary).not.toContain('To return as your output');
    });

    it('§5.E — reads parsedMeta.contentType (the real api shape) to gate binary read hints', () => {
      // `api.http.call` writes the content-type under `parsedMeta.contentType`,
      // not a top-level `contentType`. A binary response must NOT get a text
      // read-content hint, and the header should show the real type.
      const output = {
        statusCode: 200,
        data: '[binary placeholder]',
        dataRef: 'gs://bucket/blob',
        truncated: true,
        originalSizeBytes: 200_000,
        parsedMeta: { contentType: 'image/png' },
      };
      const summary = buildToolResultSummary(output, 'api-bin');
      expect(summary).toContain('[API 200');
      expect(summary).toContain('image/png');
      expect(summary).not.toContain('To read content:');
    });

    it('§5.E — output-file size is the UTF-8 byte length, not a base64 estimate', () => {
      // compute writes output files as UTF-8 text; the displayed size must match
      // the byte length, not `length * 3/4` (which under-reports by 25% for ASCII).
      const csv = 'a,b\n' + Array.from({ length: 50 }, (_, i) => `${i},${i}`).join('\n');
      const bytes = Buffer.byteLength(csv, 'utf8');
      expect(bytes).toBeLessThan(1024); // header shows raw bytes as `${n}B`
      const output = { exitCode: 0, data: 'done', stderr: '', outputFiles: { 'f.csv': csv } };
      const summary = buildToolResultSummary(output, 'comp-sz');
      expect(summary).toContain(`/run/outputs/comp-sz/outputFiles/f.csv (${String(bytes)}B)`);
      // The old base64 estimate would have under-reported.
      expect(bytes).toBeGreaterThan(Math.round((csv.length * 3) / 4));
    });
  });

  describe('Plan 252 — bounded memory read summaries', () => {
    /** A line-ranged run-output read larger than the passthrough threshold. */
    function lineReadOutput(opts: { lines?: number; totalLines?: number } = {}) {
      const shownLines = opts.lines ?? 199;
      const totalLines = opts.totalLines ?? 835;
      const data = Array.from(
        { length: shownLines },
        (_, i) => `<entry index="${String(i)}">${'x'.repeat(45)}</entry>`,
      ).join('\n');
      return {
        stat: {
          id: '00000000-0000-0000-0000-000000000000',
          path: '/run/outputs/api-call/data',
          mimeType: 'application/atom+xml',
          sizeBytes: 470_000,
        },
        data,
        range: {
          kind: 'lines',
          startLine: 1,
          endLine: 1 + shownLines,
          totalLines,
          hasMore: true,
        },
      };
    }

    it('a 14.4K line-range read is shown whole — not re-summarized into a five-line preview', () => {
      const output = lineReadOutput();
      expect(JSON.stringify(output).length).toBeGreaterThan(TOOL_RESULT_INLINE_MAX_CHARS);
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.run_output.get');
      expect(summary).toContain((output.data as string).slice(0, 500));
      expect(summary).toContain((output.data as string).slice(-500));
      expect(summary).not.toContain('Preview (first 5 lines)');
      expect(summary).toContain(
        '[Read /run/outputs/api-call/data — application/atom+xml, 459KB — lines 1..200 of 835]',
      );
    });

    it('continuation targets the ORIGINAL path, never the read call output path', () => {
      const summary = buildToolResultSummary(
        lineReadOutput(),
        'read-call-9',
        'memory.run_output.get',
      );
      expect(summary).toContain(
        '[More: memory.run_output.get({ path: "/run/outputs/api-call/data", lineRange: { startLine: 200, endLine: 399 } })]',
      );
      expect(summary).not.toContain('/run/outputs/read-call-9');
    });

    it('does not add generic compute/persist/render affordances around the content', () => {
      const summary = buildToolResultSummary(
        lineReadOutput(),
        'read-call-9',
        'memory.run_output.get',
      );
      expect(summary).not.toContain('To load in compute');
      expect(summary).not.toContain('To persist to memory');
      expect(summary).not.toContain('To visualize:');
    });

    it('memory.store.get continuations use the target-path calling shape', () => {
      const output = lineReadOutput();
      output.stat.path = '/notes/big-report.md';
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.store.get');
      expect(summary).toContain(
        '[More: memory.store.get({ target: { path: "/notes/big-report.md" }, lineRange: { startLine: 200, endLine: 399 } })]',
      );
    });

    it('emits no continuation when nothing remains', () => {
      const output = lineReadOutput({ totalLines: 200 });
      output.range.hasMore = false;
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.run_output.get');
      expect(summary).not.toContain('[More:');
    });

    it('re-cuts an over-budget line read on complete lines and continues from the shown end', () => {
      // Executor budget (16,384) exceeds the display budget (15,000): the
      // summary must cut on a line boundary and describe only what is shown.
      const output = lineReadOutput({ lines: 220 });
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.run_output.get');
      const headerMatch = /lines 1\.\.(\d+) of 835/.exec(summary);
      expect(headerMatch).not.toBeNull();
      const shownEnd = Number(headerMatch![1]);
      expect(shownEnd).toBeLessThan(221);
      expect(summary).toContain(`lineRange: { startLine: ${String(shownEnd)},`);
      // Whole lines only — the last shown line is complete.
      const body = summary.split('\n').slice(1, -1).join('\n');
      expect(body.endsWith('</entry>')).toBe(true);
    });

    it('an over-budget item window is re-packed to complete items with valid JSON', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i, pad: 'y'.repeat(150) }));
      const data = JSON.stringify(items);
      expect(data.length).toBeGreaterThan(15_000);
      const output = {
        stat: {
          path: '/run/outputs/api-call/data',
          mimeType: 'application/json',
          sizeBytes: data.length,
        },
        data,
        range: {
          kind: 'items',
          start: 0,
          count: 100,
          totalItems: 300,
          hasMore: true,
          jsonPath: 'papers',
        },
      };
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.run_output.get');
      const lines = summary.split('\n');
      const shown: unknown = JSON.parse(lines[1]!);
      expect(Array.isArray(shown)).toBe(true);
      const shownCount = (shown as unknown[]).length;
      expect(shownCount).toBeGreaterThan(0);
      expect(shownCount).toBeLessThan(100);
      expect(summary).toContain(`items 0..${String(shownCount)} of 300 at papers`);
      expect(summary).toContain(
        `[More: memory.run_output.get({ path: "/run/outputs/api-call/data", jsonPath: "papers", itemRange: { start: ${String(shownCount)}, count: ${String(shownCount)} } })]`,
      );
    });

    it('an executor-truncated whole-doc read teaches a byteRange continuation from the chars range', () => {
      const output = {
        stat: { path: '/run/outputs/api-call/data', mimeType: 'text/plain', sizeBytes: 400_000 },
        data: 'z'.repeat(14_000),
        truncated: true,
        range: { kind: 'chars', start: 0, end: 14_000, totalChars: 400_000, hasMore: true },
      };
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.run_output.get');
      expect(summary).toContain(
        '[More: memory.run_output.get({ path: "/run/outputs/api-call/data", byteRange: { start: 14000, end: 28000 } })]',
      );
      expect(summary).not.toContain('Preview (first 5 lines)');
    });

    it('a small non-truncated read still passes through with full metadata', () => {
      const output = {
        stat: { path: '/notes/small.md', mimeType: 'text/markdown', sizeBytes: 40 },
        data: 'short content',
      };
      const { text, meta } = buildToolResultSummaryWithMeta(output, 't1', 'memory.store.get');
      expect(meta.kind).toBe('passthrough');
      expect(text).toContain('short content');
      expect(text).toContain('/notes/small.md');
    });

    it('a stat-only read falls through to the ordinary path (no data to show)', () => {
      const output = {
        stat: { path: '/x', sizeBytes: 5, mimeType: 'text/plain', extra: 'k'.repeat(13_000) },
      };
      const { meta } = buildToolResultSummaryWithMeta(output, 't1', 'memory.store.get');
      expect(meta.kind).toBe('source_preview');
    });

    it('a large source result WITHOUT a read operationId keeps the bounded source preview', () => {
      const output = {
        stat: { path: '/data/train.csv', sizeBytes: 460_000, mimeType: 'text/csv' },
        data: Array.from({ length: 400 }, (_, i) => `row ${String(i)}: ${'x'.repeat(60)}`).join(
          '\n',
        ),
        truncated: true,
      };
      const summary = buildToolResultSummary(output, 'mem-456');
      expect(summary).toContain('[Memory /data/train.csv');
      expect(summary).toContain('Preview (first 5 lines)');
    });

    it('reports memory_read meta with continuation for observability', () => {
      const { meta } = buildToolResultSummaryWithMeta(
        lineReadOutput(),
        'read-call-9',
        'memory.run_output.get',
      );
      expect(meta.kind).toBe('memory_read');
      expect(meta.continuationEmitted).toBe(true);
      expect(meta.chars).toBeGreaterThan(14_000);
      expect(meta.chars).toBeLessThan(16_000);
    });

    it('a subtree chars window (jsonPath) never gets a byteRange continuation', () => {
      // A jsonPath read too large to return whole: the executor windows the
      // SERIALIZED SUBTREE, so document-offset byteRange paging is invalid.
      const output = {
        stat: { path: '/notes/big.json', mimeType: 'application/json', sizeBytes: 400_000 },
        data: '{"a":1,'.repeat(2_000),
        truncated: true,
        range: {
          kind: 'chars',
          start: 0,
          end: 14_000,
          totalChars: 50_000,
          hasMore: true,
          jsonPath: 'runs[2].metrics',
        },
      };
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.store.get');
      expect(summary).not.toContain('byteRange: {');
      expect(summary).toContain('serialized subtree at runs[2].metrics');
      expect(summary).toContain(
        '[More: memory.store.get({ target: { path: "/notes/big.json" }, jsonPath: "runs[2].metrics", view: "outline" })]',
      );
    });

    it('a truncated read WITHOUT range metadata gets no fabricated byteRange call', () => {
      // Legacy shape: truncated data whose offset space is unknown (it may be
      // a serialized subtree) — teaching a byteRange call would stitch
      // unrelated document content onto it.
      const output = {
        stat: { path: '/notes/big.json', mimeType: 'application/json', sizeBytes: 400_000 },
        data: 'x'.repeat(14_000),
        truncated: true,
      };
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.store.get');
      expect(summary).not.toContain('[More:');
      expect(summary).toContain('re-read the path with lineRange/byteRange windows');
    });

    it('a single line over the display budget teaches a maxBytes-bounded re-read of that line', () => {
      const bigLine = 'B'.repeat(15_500);
      const output = {
        stat: { path: '/run/outputs/api-call/data', mimeType: 'text/plain', sizeBytes: 400_000 },
        data: bigLine,
        range: { kind: 'lines', startLine: 7, endLine: 8, totalLines: 100, hasMore: true },
      };
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.run_output.get');
      expect(summary).toContain('line 7 (partial) of 100');
      const continuation =
        /\[More: memory\.run_output\.get\(\{ path: "\/run\/outputs\/api-call\/data", lineRange: \{ startLine: 7, endLine: 8 \}, maxBytes: (\d+) \}\)\]/.exec(
          summary,
        );
      expect(continuation).not.toBeNull();
      // The taught maxBytes forces the executor's oversized-line path, whose
      // response reports an exact chars window to page from.
      expect(Number(continuation![1])).toBeLessThanOrEqual(15_000);
    });

    it('keeps documented backlinks visible on large reads as a compact line', () => {
      const output = {
        ...lineReadOutput(),
        backlinks: [
          { fromPath: '/notes/a.md', updatedAt: '2026-01-01T00:00:00Z' },
          { fromPath: '/notes/b.md', updatedAt: '2026-01-02T00:00:00Z' },
        ],
        backlinkTotal: 5,
      };
      const summary = buildToolResultSummary(output, 'read-call-9', 'memory.store.get');
      expect(summary).toContain('[Backlinks (5): /notes/a.md, /notes/b.md]');
    });

    it('the assembled summary stays under the 16,000-char envelope even with a long path', () => {
      const longPath = `/deeply/${'nested/'.repeat(120)}doc.md`; // ~850 chars
      expect(longPath.length).toBeGreaterThan(800);
      const output = lineReadOutput();
      output.stat.path = longPath;
      const { text } = buildToolResultSummaryWithMeta(output, 'read-call-9', 'memory.store.get');
      expect(text.length).toBeLessThanOrEqual(16_000);
      expect(text).toContain(longPath);
    });
  });

  describe('Plan 158 §4.5.3 — rendered_inline stub', () => {
    it('returns the stub envelope for substrate=artifact and omits the HTML', () => {
      const output = {
        html: '<html><body>SECRET PORTFOLIO HTML</body></html>',
        data: { positions: [{ symbol: 'AAPL', shares: 100, value: 18250.5 }] },
        presentation: {
          mode: 'rendered_inline',
          substrate: 'artifact',
          payloadRef: 'inline:eyJodG1sIjoiPGh0bWwvPiJ9',
          artifactId: '00000000-0000-0000-0000-000000000001',
          versionId: '00000000-0000-0000-0000-000000000002',
        },
      };
      const summary = buildToolResultSummary(output, 'render-call-1');
      expect(summary).not.toContain('SECRET PORTFOLIO HTML');
      expect(summary).not.toContain('AAPL');
      expect(summary).not.toContain('18250');
      const parsed = JSON.parse(summary) as Record<string, unknown>;
      expect(parsed.rendered).toBe(true);
      expect(parsed.substrate).toBe('artifact');
      expect(parsed.artifactId).toBe('00000000-0000-0000-0000-000000000001');
      expect(parsed.versionId).toBe('00000000-0000-0000-0000-000000000002');
      expect(typeof parsed.note).toBe('string');
    });

    it('returns the stub envelope for substrate=surface and omits mutations', () => {
      const output = {
        surfaceId: 'sfc-abc',
        snapshot: { rootIds: ['root1'], components: {} },
        mutations: [
          { type: 'createSurface', surfaceId: 'sfc-abc' },
          { type: 'updateComponents', components: { root1: { type: 'Page' } } },
        ],
        presentation: {
          mode: 'rendered_inline',
          substrate: 'surface',
          surfaceId: 'sfc-abc',
        },
      };
      const summary = buildToolResultSummary(output, 'surface-call-1');
      expect(summary).not.toContain('createSurface');
      expect(summary).not.toContain('updateComponents');
      const parsed = JSON.parse(summary) as Record<string, unknown>;
      expect(parsed.rendered).toBe(true);
      expect(parsed.substrate).toBe('surface');
      expect(parsed.surfaceId).toBe('sfc-abc');
    });

    it('applet stub keeps the projection — the get IS the agent read — and carries the no-restate note', () => {
      const output = {
        instance: { instanceId: '00000000-0000-0000-0000-000000000003', appletKey: 'chess' },
        state: { board: 'rnbqkbnr/pppppppp', toMove: 'white' },
        stateVersion: 4,
        recentReceipts: [{ seq: 3, name: 'move', input: { from: 'e2', to: 'e4' } }],
        availableActions: ['move', 'resign', 'raw_patch'],
        situation: 'fen: rnbq w — threats: none',
        presentation: {
          mode: 'rendered_inline',
          substrate: 'applet',
          instanceId: '00000000-0000-0000-0000-000000000003',
        },
      };
      const summary = buildToolResultSummary(output, 'applet-call-1');
      const parsed = JSON.parse(summary) as Record<string, unknown>;
      expect(parsed.rendered).toBe(true);
      expect(parsed.substrate).toBe('applet');
      expect(parsed.instanceId).toBe('00000000-0000-0000-0000-000000000003');
      // Unlike artifact/surface (agent-supplied data), the projection is what
      // the agent came for — it must survive the stub.
      expect(parsed.state).toEqual({ board: 'rnbqkbnr/pppppppp', toMove: 'white' });
      expect(parsed.stateVersion).toBe(4);
      expect(parsed.recentReceipts).toHaveLength(1);
      expect(parsed.availableActions).toContain('move');
      expect(parsed.situation).toBe('fen: rnbq w — threats: none');
      // The raw instance envelope (definition metadata etc.) does not ride.
      expect(parsed.instance).toBeUndefined();
      expect(parsed.note).toBe('Board already rendered in the chat. Do not restate the position.');
    });

    it('applet act stub keeps the receipt — the action outcome is what the agent acted for', () => {
      const output = {
        receipt: {
          seq: 5,
          name: 'move',
          input: { from: 'd2', to: 'd4' },
          outcome: 'applied',
        },
        stateVersion: 5,
        gridView: '8 r n b q k b n r',
        presentation: {
          mode: 'rendered_inline',
          substrate: 'applet',
          instanceId: '00000000-0000-0000-0000-000000000003',
        },
      };
      const summary = buildToolResultSummary(output, 'applet-act-1');
      const parsed = JSON.parse(summary) as Record<string, unknown>;
      expect(parsed.rendered).toBe(true);
      expect(parsed.receipt).toEqual(output.receipt);
      expect(parsed.stateVersion).toBe(5);
      // The text board is what the agent decides from — it must survive the stub.
      expect(parsed.gridView).toBe('8 r n b q k b n r');
      expect(parsed.note).toBe('Board already rendered in the chat. Do not restate the position.');
    });

    it('falls through to normal summary when presentation.mode is summarize', () => {
      const output = {
        data: { x: 1 },
        presentation: { mode: 'summarize' },
      };
      const summary = buildToolResultSummary(output, 'normal-call');
      expect(summary).toContain('"data"');
    });

    it('falls through to normal summary when output has no presentation', () => {
      const output = { data: { x: 1 } };
      const summary = buildToolResultSummary(output, 'no-presentation');
      expect(summary).toContain('"data"');
    });
  });

  describe('Plan 158 §4.10.2c — visualize ref-passing affordance', () => {
    it('emits the affordance for API summaries whose data is an array (structured)', () => {
      const big = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        symbol: 'AAPL',
        priceCents: 18250 + i,
        v: 'x'.repeat(80),
      }));
      const output = { statusCode: 200, data: big, contentType: 'application/json' };
      const summary = buildToolResultSummary(output, 'api-XYZ');
      expect(summary).toContain('To visualize:');
      expect(summary).toContain('"$ref": "output.api-XYZ/data"');
      expect(summary).toContain('ui.surface.visualize');
      expect(summary).toContain('ui.artifact.render');
    });

    it('emits the affordance for API summaries whose data is an object (structured)', () => {
      // Single resource — JSON object body. UI ops accept object data;
      // this is the canonical "render a single record as a card" shape.
      // Pad above TOOL_RESULT_INLINE_MAX_CHARS so the summary
      // builder actually runs rather than passing the JSON verbatim.
      const positions = Array.from({ length: 200 }, (_, i) => ({
        symbol: `S${String(i)}`,
        qty: i,
        notes: 'x'.repeat(60),
      }));
      const output = {
        statusCode: 200,
        data: { portfolio: { equity: 12000, cash: 1500 }, positions },
        contentType: 'application/json',
      };
      const summary = buildToolResultSummary(output, 'api-OBJ');
      expect(summary).toContain('To visualize:');
      expect(summary).toContain('"$ref": "output.api-OBJ/data"');
    });

    it('OMITS the affordance for API summaries whose data is a plain-text body (scalar)', () => {
      // Reviewer P1: scalar /data fails UI op validation deterministically.
      // The hint must NOT appear here.
      const big = 'plain text response body '.repeat(800);
      const output = { statusCode: 200, data: big, contentType: 'text/plain' };
      const summary = buildToolResultSummary(output, 'api-TXT');
      expect(summary).not.toContain('To visualize:');
    });

    it('emits the affordance for structured memory docs (object data field)', () => {
      // Memory docs whose body is JSON arrive here as object/array — those
      // CAN be rendered. Pad above PASSTHROUGH_THRESHOLD so the summary
      // builder runs (small payloads pass through verbatim and skip the
      // affordance path entirely).
      const output = {
        stat: { path: '/state/portfolio.json', sizeBytes: 4000, mimeType: 'application/json' },
        data: {
          positions: Array.from({ length: 200 }, (_, i) => ({
            symbol: `S${String(i)}`,
            qty: i,
            notes: 'x'.repeat(60),
          })),
        },
      };
      const summary = buildToolResultSummary(output, 'mem-JSON');
      expect(summary).toContain('To visualize:');
      expect(summary).toContain('"$ref": "output.mem-JSON/data"');
    });

    it('OMITS the affordance for text-content memory docs (scalar string body)', () => {
      // Reviewer P1: `.md` / `.txt` / `.csv` content resolves to a scalar
      // string. UI ops reject scalars — drop the misleading hint.
      const output = {
        stat: { path: '/journal/2026-05.md', sizeBytes: 460000, mimeType: 'text/markdown' },
        data: Array.from({ length: 200 }, (_, i) => `entry ${String(i)}: ${'x'.repeat(80)}`).join(
          '\n',
        ),
      };
      const summary = buildToolResultSummary(output, 'mem-MD');
      expect(summary).not.toContain('To visualize:');
    });

    it('OMITS the affordance for binary memory docs (image data, etc.)', () => {
      const output = {
        stat: { path: '/uploads/chart.png', sizeBytes: 460000, mimeType: 'image/png' },
        data: 'binary-placeholder',
      };
      const summary = buildToolResultSummary(output, 'mem-bin');
      expect(summary).not.toContain('To visualize:');
    });

    it('emits the affordance for compute outputs that emit a JSON object (structured stdout)', () => {
      // Scripts that intentionally `json.dumps(...)` to stdout arrive
      // here with `shape.data` as an object. This case keeps the
      // affordance. Pad above PASSTHROUGH_THRESHOLD so the summary
      // builder runs.
      const output = {
        exitCode: 0,
        data: {
          metrics: { auc: 0.84, accuracy: 0.91 },
          rows: Array.from({ length: 200 }, (_, i) => ({
            id: i,
            score: 0.5 + i / 1000,
            notes: 'x'.repeat(60),
          })),
        },
        stderr: '',
        durationMs: 1200,
      };
      const summary = buildToolResultSummary(output, 'comp-JSON');
      expect(summary).toContain('To visualize:');
      expect(summary).toContain('"$ref": "output.comp-JSON/data"');
    });

    it('OMITS the affordance for compute outputs whose stdout is a plain string (scalar)', () => {
      // Reviewer P1: the default Python `print('line ...')` case produces
      // scalar stdout. Hide the affordance — pointing the LLM at it would
      // fail validation.
      const output = {
        exitCode: 0,
        data: Array.from({ length: 200 }, (_, i) => `row ${String(i)}: ${'x'.repeat(80)}`).join(
          '\n',
        ),
        stderr: '',
        durationMs: 1200,
      };
      const summary = buildToolResultSummary(output, 'comp-STR');
      expect(summary).not.toContain('To visualize:');
    });

    it('OMITS the affordance on small passthrough outputs (no shape detection runs)', () => {
      const output = { exitCode: 0, data: 'hello', stderr: '' };
      const summary = buildToolResultSummary(output, 'small-XYZ');
      // Passthrough returns JSON verbatim — no summary builder runs, so no
      // affordance is appended. The size guard upstream protects against
      // bloating already-short outputs.
      expect(summary).not.toContain('To visualize:');
    });
  });

  describe('Plan 320 D10 — an image an operation declares', () => {
    const OWN_REF =
      'gs://aflow-payloads/tenants/t1/runs/run-1/steps/step-shot/attempt/1/screenshot.json';
    const DESCRIPTION =
      'Screenshot of the visible window of "Report" at https://example.com/report';

    function screenshotOutput(ref: string, url = 'https://example.com/report') {
      return {
        pageId: 'pg_1',
        url,
        image: {
          ref,
          contentType: 'image/png',
          sizeBytes: 48_213,
          width: 1280,
          height: 800,
          description: DESCRIPTION,
        },
        receipt: { fullPage: false, retaken: false },
      };
    }

    it('shows its description and size in place of the image, never its reference', () => {
      const summary = buildToolResultSummary(
        screenshotOutput(OWN_REF),
        'call-1',
        'browser.page.screenshot',
      );
      expect(summary).not.toContain(OWN_REF);
      expect(summary).not.toContain('gs://');
      expect(JSON.parse(summary)).toEqual({
        pageId: 'pg_1',
        url: 'https://example.com/report',
        image: {
          contentType: 'image/png',
          sizeBytes: 48_213,
          width: 1280,
          height: 800,
          description: DESCRIPTION,
        },
        receipt: { fullPage: false, retaken: false },
      });
    });

    it.each([
      [
        'another step',
        'gs://aflow-payloads/tenants/t1/runs/run-1/steps/step-2/attempt/1/body.json',
      ],
      ['an inline payload', `inline:${Buffer.from('{"data":"iVBORw0KGgo="}').toString('base64')}`],
    ])('never shows the reference of an image it withholds, naming %s', (_label, ref) => {
      const summary = buildToolResultSummary(
        screenshotOutput(ref),
        'call-1',
        'browser.page.screenshot',
      );
      expect(summary).not.toContain(ref);
      expect((JSON.parse(summary) as { image: unknown }).image).toEqual({
        contentType: 'image/png',
        sizeBytes: 48_213,
        width: 1280,
        height: 800,
        description: DESCRIPTION,
      });
    });

    it('keeps the reference out of a summary too large to pass through', () => {
      const long = `https://example.com/report?${'q'.repeat(TOOL_RESULT_INLINE_MAX_CHARS)}`;
      const { text, meta } = buildToolResultSummaryWithMeta(
        screenshotOutput(OWN_REF, long),
        'call-1',
        'browser.page.screenshot',
      );
      expect(meta.kind).toBe('source_preview');
      expect(text).not.toContain(OWN_REF);
      expect(text).not.toContain('gs://');
    });

    it('leaves the same shape alone in an operation that declares no image', () => {
      const output = { status: 200, data: screenshotOutput(OWN_REF) };
      const summary = buildToolResultSummary(output, 'call-1', 'api.http.call');
      expect(JSON.parse(summary)).toEqual(output);
    });
  });
});
