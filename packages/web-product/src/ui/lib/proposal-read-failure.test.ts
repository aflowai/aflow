/**
 * The proposal card shows why a proposal cannot be read, in the words the
 * proposal route's 404 sends, rather than a bare "not found".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeProposalReadFailure, readProposalReadFailure } from './proposal-read-failure';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readProposalReadFailure', () => {
  it('names the failing fields of an unparseable proposal', async () => {
    const message =
      'The proposal document exists in this space but does not parse as a staged change (schema). What failed: proposal.ops.0.task.inputContract: Unrecognized key';
    await expect(
      readProposalReadFailure(json(404, { error: 'Proposal unreadable', message })),
    ).resolves.toBe(`Proposal unreadable: ${message}`);
  });

  it('says a deleted proposal has been deleted', async () => {
    await expect(
      readProposalReadFailure(
        json(404, {
          error: 'Proposal unreadable',
          message: 'The proposal with this id has been deleted from this space.',
        }),
      ),
    ).resolves.toContain('has been deleted');
  });

  it('says a refused path is refused', async () => {
    await expect(
      readProposalReadFailure(
        json(404, {
          error: 'Proposal unreadable',
          message:
            'The proposal path is reserved scratch space, and the memory store refuses to read it.',
        }),
      ),
    ).resolves.toContain('refuses to read it');
  });

  it('says a missing proposal is missing', async () => {
    await expect(
      readProposalReadFailure(
        json(404, {
          error: 'Proposal not found',
          message: 'No proposal with this id exists in this space.',
        }),
      ),
    ).resolves.toBe('Proposal not found: No proposal with this id exists in this space.');
  });

  it('falls back to the status when the body says nothing', async () => {
    await expect(readProposalReadFailure(new Response('oops', { status: 502 }))).resolves.toBe(
      'HTTP 502',
    );
    expect(describeProposalReadFailure(500, { error: 'Internal' })).toBe('HTTP 500: Internal');
  });
});

describe('every proposal card loader surfaces the read failure', () => {
  const loaders = [
    '../hooks/use-action-center.ts',
    '../hooks/use-coach-surface.ts',
    '../components/workflow-proposals-tab.tsx',
  ];
  it.each(loaders)('%s throws the 404 reason for the card to show', (relative) => {
    const src = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    expect(src).toMatch(/throw new Error\(await readProposalReadFailure\(res\)\)/);
  });
});
