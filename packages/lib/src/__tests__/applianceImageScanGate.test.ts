/**
 * The release workflow's vulnerability gate blocks on a high or critical finding
 * that has a fix, and not on one without. The gate is shell inside a workflow
 * that runs only on a tag, so nothing else reads it.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/appliance-image.yml');
const STEP = 'What the image is vulnerable to';

/**
 * The step's `run:` block, de-indented. Read as text rather than through a YAML
 * parser so this needs no dependency `@aflow/lib` does not declare — a hoisted
 * package resolves here and then does not resolve in the cut.
 */
function gateScript(): string {
  const lines = readFileSync(WORKFLOW, 'utf-8').split('\n');
  const at = lines.findIndex((line) => line.trim() === `- name: ${STEP}`);
  if (at === -1) throw new Error(`${WORKFLOW} has no step named ${STEP}`);

  const runAt = lines.findIndex((line, i) => i > at && line.trim() === 'run: |');
  if (runAt === -1) throw new Error(`the ${STEP} step carries no run block`);

  const body: string[] = [];
  const indent = (lines[runAt] ?? '').search(/\S/) + 2;
  for (const line of lines.slice(runAt + 1)) {
    // A blank line inside the block is still inside it.
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** Stands in for the scanner: the gate is under test, Trivy is not. */
const STUB_DOCKER = `#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--output" ]; then out="$2"; fi
  shift
done
cp "$FIXTURE" "$out"
`;

interface Finding {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
}

function runGate(findings: Finding[]): { status: number; stderr: string; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aflow-scan-gate-'));
  const work = join(dir, 'work');
  const bin = join(dir, 'bin');
  mkdirSync(work);
  mkdirSync(bin);

  writeFileSync(join(bin, 'docker'), STUB_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);

  const fixture = join(dir, 'report.json');
  // A result carrying no `Vulnerabilities` key at all is what a clean layer looks
  // like, and the gate has to tolerate it rather than error on it.
  writeFileSync(
    fixture,
    JSON.stringify({
      Results: [{ Target: 'debian', Vulnerabilities: findings }, { Target: 'app/yarn.lock' }],
    }),
  );

  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  const script = join(dir, 'gate.sh');
  writeFileSync(script, gateScript());

  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', [script], {
      cwd: work,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        FIXTURE: fixture,
        IMAGE: 'ghcr.io/aflowai/aflow-appliance',
        DIGEST: 'sha256:0f00',
        VERSION: 'appliance-v0.0.0-test',
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    status = failure.status ?? -1;
    stderr = failure.stderr ?? '';
  }
  return { status, stderr, summary: readFileSync(summary, 'utf-8') };
}

const FIXABLE_CRITICAL: Finding = {
  VulnerabilityID: 'CVE-0000-0001',
  PkgName: 'libssl3',
  InstalledVersion: '3.0.11-1',
  FixedVersion: '3.0.15-1',
  Severity: 'CRITICAL',
};
const UNFIXED_HIGH: Finding = {
  VulnerabilityID: 'CVE-0000-0002',
  PkgName: 'perl-base',
  InstalledVersion: '5.36.0',
  Severity: 'HIGH',
};
const FIXABLE_MEDIUM: Finding = {
  VulnerabilityID: 'CVE-0000-0003',
  PkgName: 'gzip',
  InstalledVersion: '1.12',
  FixedVersion: '1.13',
  Severity: 'MEDIUM',
};

describe('the release image vulnerability gate', () => {
  it('blocks a release whose high or critical finding has a fix', () => {
    const { status, stderr, summary } = runGate([FIXABLE_CRITICAL, UNFIXED_HIGH, FIXABLE_MEDIUM]);
    expect(status).toBe(1);
    expect(stderr).toContain('libssl3');
    expect(stderr).toContain('3.0.15-1');
    expect(summary).toContain('Blocking');
    // The one with no fix is reported, never presented as blocking.
    expect(summary.slice(summary.indexOf('Blocking'))).not.toContain('perl-base');
  });

  it('releases when nothing high or critical has a fix', () => {
    const { status, summary } = runGate([UNFIXED_HIGH, FIXABLE_MEDIUM]);
    expect(status).toBe(0);
    expect(summary).not.toContain('Blocking');
    // Counted and shown, so a reader sees what was accepted rather than nothing.
    expect(summary).toContain('| HIGH | 1 | 0 |');
  });

  it('does not block on severity alone, nor on a fix alone', () => {
    expect(runGate([FIXABLE_MEDIUM]).status).toBe(0);
    expect(runGate([UNFIXED_HIGH]).status).toBe(0);
    expect(runGate([FIXABLE_CRITICAL]).status).toBe(1);
  });
});
