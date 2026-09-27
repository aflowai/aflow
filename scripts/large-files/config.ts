export const THRESHOLDS = {
  /** Soft warning for production TS/TSX (scan output only — not blocking). */
  warnLines: 800,
  /** Hard gate for new production TS/TSX (unless allowlisted). */
  hardLines: 1500,
  /** Max lines an existing baseline entry may grow before check fails. */
  growthToleranceLines: 50,
} as const;

/** Repo-root-relative directory segments skipped entirely during scan. */
export const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  '.next',
  'coverage',
  '.turbo',
  '.git',
  'build',
  '.cache',
  '.yarn',
  'storybook-static',
  '.claude',
  '.codex',
]);

/** Path substrings that exclude a file even when under an otherwise scanned tree. */
export const EXCLUDED_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/.next/',
  '/coverage/',
  '/.turbo/',
  '/storybook-static/',
  '/.claude/',
  '/.codex/',
] as const;

export const BASELINE_PATH = 'scripts/large-file-baseline.json';
export const ALLOWLIST_PATH = 'scripts/large-file-allowlist.json';
