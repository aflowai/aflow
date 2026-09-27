import { describe, it, expect } from 'vitest';
import type { StoredSessionMetadata } from '@aflow/database';
import {
  projectSessionMetadata,
  projectSessionMetadataDetail,
} from '../services/sessionMetadataProjection.js';

const base = (over: Partial<StoredSessionMetadata> = {}): StoredSessionMetadata => ({
  sessionId: 's',
  spaceId: 'sp',
  createdBy: null,
  executionAuthority: null,
  status: 'PAUSED',
  startedAt: new Date('2026-09-19T10:00:00Z'),
  lastActivityAt: new Date('2026-09-19T11:00:00Z'),
  title: null,
  titleState: null,
  manualTitle: null,
  summary: null,
  summaryCoverage: null,
  metadataRevision: 0,
  metadataEvidenceRevision: null,
  metadataUpdatedAt: null,
  metadataEditedBy: null,
  record: {},
  ...over,
});

describe('resolving a conversation name', () => {
  it("shows a person's name over the generated one", () => {
    // The two live in different columns for exactly this: a generation landing
    // seconds after a rename writes a column this read then declines.
    const metadata = projectSessionMetadata(
      base({ title: 'Missing invoices', titleState: 'established', manualTitle: 'Q3 billing' }),
    );
    expect(metadata.title).toBe('Q3 billing');
    expect(metadata.titleSource).toBe('manual');
  });

  it("reports no automatic state for a person's name", () => {
    // Nothing will refine it, and showing `established` would suggest
    // something is still deciding.
    const metadata = projectSessionMetadata(
      base({ title: 'Missing invoices', titleState: 'provisional', manualTitle: 'Q3 billing' }),
    );
    expect(metadata.titleState).toBeNull();
  });

  it('falls back to the generated name once the manual one is cleared', () => {
    const metadata = projectSessionMetadata(
      base({ title: 'Missing invoices', titleState: 'established', manualTitle: null }),
    );
    expect(metadata).toMatchObject({
      title: 'Missing invoices',
      titleSource: 'generated',
      titleState: 'established',
    });
  });

  it('says a conversation is still pending only while nothing has been written', () => {
    expect(projectSessionMetadata(base()).pending).toBe(true);
    expect(projectSessionMetadata(base({ title: 'Anything' })).pending).toBe(false);
    expect(projectSessionMetadata(base({ summary: 'Anything' })).pending).toBe(false);
  });

  it('keeps a summary through a rename', () => {
    const metadata = projectSessionMetadata(
      base({ summary: 'Three invoices are missing.', manualTitle: 'Q3 billing' }),
    );
    expect(metadata.summary).toBe('Three invoices are missing.');
  });

  it('carries provenance and the last diagnostic only into the detail read', () => {
    const stored = base({
      record: {
        diagnostic: {
          code: 'no_clerk_model',
          message: 'No economical model is available.',
          at: '2026-09-19T11:00:00.000Z',
          retryable: false,
          attempts: 0,
        },
      },
    });
    expect('diagnostic' in projectSessionMetadata(stored)).toBe(false);
    expect(projectSessionMetadataDetail(stored).diagnostic?.code).toBe('no_clerk_model');
    expect(projectSessionMetadataDetail(stored).provenance).toBeNull();
  });
});
