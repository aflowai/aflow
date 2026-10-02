/**
 * Which Chrome-family browser is installed here, observed rather than declared.
 *
 * Looked for at the places the vendors install to, and nowhere a job could
 * write: the browser this finds is started with the operator's own rights, so
 * where it comes from is the operator's installer, not a search path.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChromeCandidate {
  readonly label: string;
  readonly path: string;
}

export interface ChromeDiscovery {
  readonly found?: ChromeCandidate;
  /** Every place looked, in order, so a refusal can say where. */
  readonly searched: readonly string[];
}

const SUPPORTED_BROWSERS = 'Google Chrome, Chromium or Microsoft Edge';

function macCandidates(home: string): ChromeCandidate[] {
  const bundles: Array<[string, string]> = [
    ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
    ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ];
  return ['/Applications', join(home, 'Applications')].flatMap((dir) =>
    bundles.map(([label, bundle]) => ({ label, path: join(dir, bundle) })),
  );
}

const LINUX_CANDIDATES: readonly ChromeCandidate[] = [
  { label: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
  { label: 'Google Chrome', path: '/usr/bin/google-chrome' },
  { label: 'Google Chrome', path: '/opt/google/chrome/chrome' },
  { label: 'Chromium', path: '/usr/bin/chromium' },
  { label: 'Chromium', path: '/usr/bin/chromium-browser' },
  { label: 'Chromium', path: '/snap/bin/chromium' },
  { label: 'Microsoft Edge', path: '/usr/bin/microsoft-edge-stable' },
  { label: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
  { label: 'Microsoft Edge', path: '/opt/microsoft/msedge/msedge' },
];

export function chromeCandidates(platform: NodeJS.Platform, home: string): ChromeCandidate[] {
  if (platform === 'darwin') return macCandidates(home);
  if (platform === 'linux') return [...LINUX_CANDIDATES];
  return [];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function discoverChrome(
  options: {
    platform?: NodeJS.Platform;
    home?: string;
    isExecutable?: (path: string) => boolean;
  } = {},
): ChromeDiscovery {
  const candidates = chromeCandidates(
    options.platform ?? process.platform,
    options.home ?? homedir(),
  );
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const found = candidates.find((candidate) => isExecutable(candidate.path));
  return {
    ...(found !== undefined ? { found } : {}),
    searched: candidates.map((candidate) => candidate.path),
  };
}

export function chromeMissingMessage(discovery: ChromeDiscovery): string {
  if (discovery.searched.length === 0) {
    return (
      `No browser was found on this machine: the host executor looks for ${SUPPORTED_BROWSERS} ` +
      `on macOS and Linux only, and this is ${process.platform}.`
    );
  }
  return (
    `No browser was found on this machine. ${SUPPORTED_BROWSERS} count, and none is installed ` +
    `where the host executor looked: ${discovery.searched.join(', ')}. Install one of them; ` +
    'the next page opened finds it.'
  );
}
