import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_PATH = resolve(__dirname, '../proposalResolution.ts');

/**
 * Extract a function's body as the substring between the function's
 * opening line and the matching closing brace at column 0 (we follow the
 * file's existing convention: every export's body terminates with a
 * line containing only `}`).
 */
function extractFunctionBody(source: string, fnName: string): string {
  const startRegex = new RegExp(`export async function ${fnName}\\b`);
  const startMatch = startRegex.exec(source);
  if (!startMatch) {
    throw new Error(`Function ${fnName} not found in ${SOURCE_PATH}`);
  }
  const startIdx = startMatch.index;
  // Find the next `^}` line after `startIdx`.
  const tail = source.slice(startIdx);
  const closeMatch = /^}/m.exec(tail);
  if (!closeMatch) {
    throw new Error(`Could not find closing brace for ${fnName}`);
  }
  return tail.slice(0, closeMatch.index + 1);
}

describe('dismissProposal — Plan 138 §5.8 invariant pin', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  it('dismissProposal body does NOT call recordRejectedFingerprint', () => {
    const body = extractFunctionBody(source, 'dismissProposal');
    expect(body).not.toContain('recordRejectedFingerprint');
  });

  it("dismissProposal body does NOT emit 'entity.coach.rejected'", () => {
    const body = extractFunctionBody(source, 'dismissProposal');
    expect(body).not.toContain('entity.coach.rejected');
  });

  it("dismissProposal body DOES emit 'entity.coach.platform_issue_acknowledged'", () => {
    // The positive assertion catches the inverse regression — a refactor
    // that strips the neutral ack event entirely (would silently break the
    // operator-facing audit trail).
    const body = extractFunctionBody(source, 'dismissProposal');
    expect(body).toContain('entity.coach.platform_issue_acknowledged');
  });

  // Sanity: confirm rejectProposal DOES do the things dismiss must not.
  // If this pin breaks, either reject was refactored or our function
  // extractor is buggy — both are worth seeing red.
  it('rejectProposal body DOES call recordRejectedFingerprint (sanity)', () => {
    const body = extractFunctionBody(source, 'rejectProposal');
    expect(body).toContain('recordRejectedFingerprint');
  });

  // Only ratification applies a proposal's ops. For side-effectful kinds
  // (store_install runs a real install on apply) a reject/dismiss that
  // reached applyRatifiedOps would mutate the space against the operator's
  // decision.
  it('rejectProposal and dismissProposal bodies do NOT call applyRatifiedOps', () => {
    expect(extractFunctionBody(source, 'rejectProposal')).not.toContain('applyRatifiedOps');
    expect(extractFunctionBody(source, 'dismissProposal')).not.toContain('applyRatifiedOps');
  });
});
