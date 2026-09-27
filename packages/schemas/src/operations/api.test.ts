import { describe, it, expect } from 'vitest';
import { ApiCallInputSchema, ApiHttpDownloadInputSchema } from './api.js';

const BASE = {
  apiId: 'example',
  endpointId: 'upload',
};

describe('ApiCallInputSchema — bodySource.emitContentRange (§4.5a)', () => {
  it('accepts emitContentRange with fromPath', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      bodySource: { fromPath: '/workspace/data/submission.csv', emitContentRange: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bodySource?.emitContentRange).toBe(true);
    }
  });

  it('rejects a manual Content-Range header alongside emitContentRange', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      bodySource: { fromPath: '/workspace/data/submission.csv', emitContentRange: true },
      headers: { 'Content-Range': 'bytes 0-99/100' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'headers')).toBe(true);
      expect(parsed.error.issues.some((i) => /Content-Range/.test(i.message))).toBe(true);
    }
  });

  it('header detection is case-insensitive', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      bodySource: { fromPath: '/workspace/x.csv', emitContentRange: true },
      headers: { 'content-range': 'bytes 0-9/10' },
    });
    expect(parsed.success).toBe(false);
  });

  it('a manual Content-Range header WITHOUT the flag stays valid (manual mode)', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      bodySource: { fromPath: '/workspace/x.csv' },
      headers: { 'Content-Range': 'bytes 0-9/10' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('ApiCallInputSchema — response.saveTo (§4.5b)', () => {
  it('accepts a saveTo target with optional docType/mimeType', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      response: { saveTo: { path: '/workspace/data/train.csv', mimeType: 'text/csv' } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.response.saveTo?.path).toBe('/workspace/data/train.csv');
    }
  });

  it('rejects virtual /run/ paths', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      response: { saveTo: { path: '/run/outputs/abc/data' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown docType values', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      response: { saveTo: { path: '/workspace/x.bin', docType: 'not-a-doctype' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an indexing hint on saveTo', () => {
    const parsed = ApiCallInputSchema.safeParse({
      ...BASE,
      response: { saveTo: { path: '/workspace/data/train.csv', indexing: 'disabled' } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.response.saveTo?.indexing).toBe('disabled');
    }
  });
});

describe('ApiHttpDownloadInputSchema — destination-mandated download', () => {
  it('accepts endpoint mode with toMemoryPath and defaults indexing to disabled', () => {
    const parsed = ApiHttpDownloadInputSchema.safeParse({
      apiId: 'kaggle',
      endpointId: 'download_competition_data_file',
      params: { competitionName: 'playground-series-s6e7', fileName: 'train.csv' },
      toMemoryPath: '/workspace/data/playground-series-s6e7/train.csv',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.toMemoryPath).toBe('/workspace/data/playground-series-s6e7/train.csv');
      expect(parsed.data.indexing).toBe('disabled'); // raw data is not embedded by default
      expect(parsed.data.timeoutMs).toBe(120_000); // downloads default high
    }
  });

  it('rejects a missing toMemoryPath, naming the field', () => {
    const parsed = ApiHttpDownloadInputSchema.safeParse({
      apiId: 'kaggle',
      endpointId: 'download_competition_data_file',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'toMemoryPath')).toBe(true);
    }
  });

  it('rejects a virtual /run/ destination', () => {
    const parsed = ApiHttpDownloadInputSchema.safeParse({
      apiId: 'kaggle',
      endpointId: 'download_competition_data_file',
      toMemoryPath: '/run/outputs/abc/data',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'toMemoryPath')).toBe(true);
    }
  });

  it('has no inline surface — a stray response/format is dropped, never an inline download', () => {
    const parsed = ApiHttpDownloadInputSchema.safeParse({
      apiId: 'kaggle',
      endpointId: 'download_competition_data_file',
      toMemoryPath: '/workspace/data/train.csv',
      response: { format: 'text', maxBytes: 1024 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('response' in parsed.data).toBe(false);
    }
  });

  it('requires bindingId in direct-URL mode', () => {
    const parsed = ApiHttpDownloadInputSchema.safeParse({
      apiId: 'kaggle',
      url: 'https://storage.googleapis.com/bucket/train.csv',
      toMemoryPath: '/workspace/data/train.csv',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'bindingId')).toBe(true);
    }
  });

  it('requires apiId or url', () => {
    const parsed = ApiHttpDownloadInputSchema.safeParse({
      toMemoryPath: '/workspace/data/train.csv',
    });
    expect(parsed.success).toBe(false);
  });
});
