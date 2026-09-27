/**
 * An icon this application names has to be one this application serves.
 *
 * Next serves `public/` from the app being built, and nothing else — not a
 * sibling app's, not the repository root. The reference was copied from the
 * hosted app, where the file exists, into an app that had no `public/` directory
 * at all, so every local page requested a guaranteed 404 for its favicon. Nothing
 * reports that: a missing icon is a blank tab, not an error.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAYOUT_SRC = readFileSync(resolve(__dirname, './layout.tsx'), 'utf8');
const PUBLIC_DIR = resolve(__dirname, '../../public');
const SHARED_CHAT_ASSETS = [
  '/frog.svg',
  '/orb-running.svg',
  '/orb-running-light.svg',
  '/orb-paused.svg',
  '/orb-paused-light.svg',
  '/orb-completed.svg',
  '/orb-completed-light.svg',
  '/orb-failed.svg',
  '/orb-failed-light.svg',
  '/orb-inert.svg',
  '/orb-inert-light.svg',
  '/orb-idle.svg',
  '/orb-idle-light.svg',
  '/orb-searching.svg',
  '/orb-searching-light.svg',
] as const;

/** Every absolute asset path the layout's metadata points at. */
function referencedAssets(src: string): string[] {
  const icons = src.match(/icons:\s*\{[\s\S]*?\}/);
  if (!icons) return [];
  return [...icons[0].matchAll(/'(\/[^']+)'/g)].map((m) => m[1] as string);
}

describe('the local app serves the icons it names', () => {
  it('has a public file for every icon in its metadata and shared chat assets', () => {
    const referenced = [...new Set([...referencedAssets(LAYOUT_SRC), ...SHARED_CHAT_ASSETS])];
    expect(referenced.length, 'no icons found to check — has the metadata moved?').toBeGreaterThan(
      0,
    );
    for (const asset of referenced) {
      const onDisk = resolve(PUBLIC_DIR, asset.replace(/^\//, ''));
      expect(existsSync(onDisk), `${asset} is referenced but this app does not serve it`).toBe(
        true,
      );
    }
  });
});
