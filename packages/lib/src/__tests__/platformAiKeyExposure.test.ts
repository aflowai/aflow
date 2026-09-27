/**
 * Contract: platform AI environment keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`,
 * …) fund the memory-embedding infrastructure ONLY. Every other model call is
 * BYOK — resolved from the caller's credential chain with no env fallback —
 * because the public tenant carries these env keys for embeddings, and any
 * additional reader would let a hostile signup spend platform money. A new
 * consumer must either move to the BYOK factory
 * (`createByokAiClientFactory` in @aflow/credential-resolver) or be a
 * deliberate, reviewed addition to this allowlist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ownerOf, survivesCoreCut } from '@aflow/schemas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');

const KEY_PATTERN =
  /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_AI_API_KEY|FIREWORKS_API_KEY|OPENROUTER_API_KEY/;

const ALLOWED_CONSUMERS = [
  // Memory-embedding infrastructure (the D3 exception)
  'apps/aflow-executor-ai/src/workers/memoryEmbedder.ts',
  'apps/aflow-executor-memory/src/embedder.ts',
  'apps/aflow-executor-memory/src/handlers/memory/handlers/query.ts',
  'apps/aflow-executor-memory/src/handlers/memory/providers.ts',
  // Coding-lane secret ISOLATION — scrubs these keys OUT of the lane env
  'apps/aflow-executor-code/src/secrets/isolation.ts',
].sort();

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      statSync(full).isFile()
    ) {
      out.push(full);
    }
  }
}

/**
 * Files that name these keys without reading them.
 *
 * The property here is *consumption* — a reader can spend platform money — and
 * the ownership manifest classifies every environment key the repository has,
 * which means writing their names down. Listing it as a consumer would say
 * something false about it and blunt what the allowlist means.
 */
const NAMES_WITHOUT_READING = ['packages/schemas/src/edition/ownership.ts'];

describe('platform AI env-key exposure', () => {
  it('only the embedding infrastructure reads platform AI env keys', () => {
    const files: string[] = [];
    for (const segment of ['apps', 'packages']) {
      for (const ws of readdirSync(join(REPO_ROOT, segment), { withFileTypes: true })) {
        if (!ws.isDirectory()) continue;
        const srcDir = join(REPO_ROOT, segment, ws.name, 'src');
        try {
          collectSourceFiles(srcDir, files);
        } catch {
          // workspace without src/
        }
      }
    }

    const consumers = files
      .filter((f) => KEY_PATTERN.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f))
      .filter((f) => !NAMES_WITHOUT_READING.includes(f))
      .sort();

    // The coding lane is one of the allowed readers and a public core does not
    // contain it, so an allowlist demanding it be found would fail for the lane
    // being absent. Relaxed only where the file is genuinely one the cut
    // removes — an entry naming a core file that vanished is still a failure,
    // and a file that starts reading a platform key without being listed always
    // was.
    const expected = ALLOWED_CONSUMERS.filter((f) => {
      if (existsSync(join(REPO_ROOT, f))) return true;
      const owner = ownerOf(f);
      return owner !== undefined && survivesCoreCut(owner.owner);
    });
    expect(consumers).toEqual(expected);
  });
});
