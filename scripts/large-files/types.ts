export type FileCategory = 'production' | 'test' | 'seed' | 'fixture' | 'generated';

export interface ScannedFile {
  /** Repo-root-relative POSIX path. */
  path: string;
  lines: number;
  category: FileCategory;
}

export interface BaselineFileEntry {
  lines: number;
  category: FileCategory;
}

export interface LargeFileBaseline {
  version: 1;
  capturedAt: string;
  thresholds: {
    warnLines: number;
    hardLines: number;
    growthToleranceLines: number;
  };
  /** Production files at or above hardLines when baseline was captured. */
  files: Record<string, BaselineFileEntry>;
}

export interface AllowlistEntry {
  /** Repo-root-relative POSIX path or glob (minimatch). */
  path: string;
  reason: string;
  owner: string;
  /** Optional ceiling when allowlisted; omit to exempt the file from the new-file hard gate. */
  maxLines?: number;
}

export interface LargeFileAllowlist {
  version: 1;
  entries: AllowlistEntry[];
}

export interface CheckViolation {
  kind: 'new_over_budget' | 'baseline_growth' | 'allowlist_invalid';
  path: string;
  lines: number;
  message: string;
}

export interface ScanReport {
  scannedAt: string;
  files: ScannedFile[];
  warnings: ScannedFile[];
  overHardProduction: ScannedFile[];
}
