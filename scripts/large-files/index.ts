export { THRESHOLDS, BASELINE_PATH, ALLOWLIST_PATH } from './config.js';
export { classifyFile } from './classify.js';
export { countLines, scanRepository, buildScanReport, formatScanReport } from './scan.js';
export { checkAgainstBaseline, buildBaselineFromScan, formatCheckResult } from './check.js';
export { pathMatchesAllowlist, validateAllowlist } from './allowlist.js';
export type {
  FileCategory,
  ScannedFile,
  LargeFileBaseline,
  LargeFileAllowlist,
  AllowlistEntry,
  CheckViolation,
  ScanReport,
} from './types.js';
