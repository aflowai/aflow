/**
 * Secret scan over every reachable blob, for the categories gitleaks does not
 * rule on.
 *
 * Run beside `gitleaks git --log-opts="--all"`, not instead of it: neither is a
 * superset. Measured against a fixture repository holding a real-shaped AWS
 * access key id, a Fireworks key and a password-bearing Postgres URL in a blob
 * deleted from the tree, gitleaks' default ruleset reported no leaks — it rules
 * on `private-key` and `github-pat`, and carries none for a bare `AKIA` id, the
 * classic `ghp_` form, a Fireworks key or a credential-bearing connection
 * string. This one catches those and misses what gitleaks catches, so a single
 * scanner produces a confident false clean in whichever direction it is weak.
 *
 * Usage: `node scripts/history-secret-scan.mjs <repo>`.
 *
 * Reads blobs through one `git cat-file --batch` stream, so tens of thousands of
 * objects cost one process rather than one process each.
 */
import { spawn } from 'node:child_process';

const repo = process.argv[2];
if (repo === undefined) throw new Error('usage: node history-secret-scan.mjs <repo>');

/** High-confidence shapes only: a pattern that fires on documentation is noise. */
const PATTERNS = [
  { name: 'aflow api key', re: /\bphx_[A-Za-z0-9_-]{32,}/g },
  { name: 'openai key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: 'anthropic key', re: /\bsk-ant-(?:api|oat)[A-Za-z0-9_-]{20,}/g },
  { name: 'google api key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'aws access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'gcp service account private key', re: /"type":\s*"service_account"/g },
  { name: 'pem private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'github token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'stripe secret', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
  { name: 'fireworks key', re: /\bfw_[A-Za-z0-9]{20,}/g },
  { name: 'postgres url with password', re: /postgres(?:ql)?:\/\/[^\s:@/"']+:[^\s:@/"']{8,}@/g },
  { name: 'redis url with password', re: /redis:\/\/[^\s:@/"']*:[^\s:@/"']{8,}@/g },
];

/** Placeholders and fixtures a real pattern still matches. */
const BENIGN = [
  /example|sample|placeholder|dummy|fixture|redacted|your[-_]?key|xxx+|<[^>]+>/i,
  /\b(?:test|mock|fake)[-_]?(?:key|token|secret|password)\b/i,
  /0{8,}|1{8,}|a{8,}|changeme|password123|postgres:\/\/phoenix:phoenix@/i,
];

const SKIP_PATH =
  /(?:^|\/)(?:yarn\.lock|package-lock\.json|\.min\.js|\.map)$|\.(png|jpe?g|gif|svg|ico|woff2?|ttf|mp4|webm|pdf|zip|gz)$/i;

function listObjects() {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-list', '--all', '--objects'], { cwd: repo });
    let buffer = '';
    const objects = [];
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const space = line.indexOf(' ');
        if (space === -1) continue;
        const path = line.slice(space + 1);
        if (path === '' || SKIP_PATH.test(path)) continue;
        objects.push({ sha: line.slice(0, space), path });
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve(objects);
    });
  });
}

/** Stream blob contents through one long-lived cat-file process. */
function readBlobs(objects, onBlob) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo });
    const queue = objects.slice();
    let index = 0;
    let pending = Buffer.alloc(0);
    let header = null;

    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (header === null) {
          const newline = pending.indexOf(0x0a);
          if (newline === -1) return;
          const parts = pending.subarray(0, newline).toString('utf8').split(' ');
          pending = pending.subarray(newline + 1);
          if (parts[1] === 'missing' || parts[1] === undefined) {
            index += 1;
            continue;
          }
          header = { type: parts[1], size: Number(parts[2]) };
        }
        if (pending.length < header.size + 1) return;
        const body = pending.subarray(0, header.size);
        pending = pending.subarray(header.size + 1);
        if (header.type === 'blob' && !body.includes(0)) {
          onBlob(queue[index], body.toString('utf8'));
        }
        header = null;
        index += 1;
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve();
    });
    child.stdin.end(queue.map((o) => o.sha).join('\n') + '\n');
  });
}

const objects = await listObjects();
const findings = new Map();
let scanned = 0;

await readBlobs(objects, (object, text) => {
  scanned += 1;
  if (text.length > 2_000_000) return;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(text)) !== null) {
      const matched = hit[0];
      const lineStart = text.lastIndexOf('\n', hit.index) + 1;
      const lineEnd = text.indexOf('\n', hit.index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      if (BENIGN.some((b) => b.test(line))) continue;
      const key = `${name}::${matched.slice(0, 12)}::${object.path}`;
      if (findings.has(key)) continue;
      findings.set(key, {
        kind: name,
        path: object.path,
        sha: object.sha,
        preview: `${matched.slice(0, 8)}…(${matched.length} chars)`,
        context: line.slice(0, 120),
      });
    }
  }
});

console.log(`objects listed: ${objects.length}`);
console.log(`text blobs scanned: ${scanned}`);
console.log(`distinct findings: ${findings.size}\n`);

const byKind = new Map();
for (const f of findings.values()) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`## ${kind} — ${list.length}`);
  for (const f of list.slice(0, 8)) {
    console.log(`  ${f.path}`);
    console.log(`    ${f.preview}  blob ${f.sha.slice(0, 9)}`);
    console.log(`    ${f.context}`);
  }
  if (list.length > 8) console.log(`  … ${list.length - 8} more`);
  console.log('');
}
if (findings.size === 0) console.log('No live credential shape matched in reachable history.');
