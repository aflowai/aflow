/**
 * Loading the credential pairing wrote.
 *
 * `pair` writes `host.env` next to the policy and tells the operator the
 * machine is paired. The executor then did not read it — it resolved Redis from
 * the ambient environment and, finding nothing, fell through to a default. The
 * result was an executor that started cleanly and talked to the wrong Redis, or
 * to none, while the file naming the right one sat beside its policy.
 *
 * Anything already set in the environment wins, so an operator running against
 * something other than what they paired with can still say so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `KEY='value'` or `KEY=value`, one per line, as `pair` writes it. */
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Read `host.env` from the host directory into the environment. Returns the
 * names it set, so a caller can say what pairing supplied without printing a
 * credential.
 */
export function loadPairedEnv(
  hostDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { applied: string[]; shadowed: string[] } {
  let raw: string;
  try {
    raw = readFileSync(join(hostDir, 'host.env'), 'utf8');
  } catch {
    // Not paired yet. The executor says so in its own words further up; this is
    // not the place to decide that is fatal.
    return { applied: [], shadowed: [] };
  }

  const applied: string[] = [];
  const shadowed: string[] = [];
  for (const line of raw.split('\n')) {
    const match = LINE.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const key = match[1];
    // An ambient value wins, which is right for an operator overriding on
    // purpose and silent for one who is not. `REDIS_URL` is the dangerous case:
    // pointed at another instance's Redis the executor starts cleanly, claims
    // nothing, and looks from the appliance exactly like a lane that is down.
    // So a shadowed key is reported rather than merely skipped.
    if (env[key] !== undefined && env[key] !== '') {
      shadowed.push(key);
      continue;
    }
    env[key] = unquote(match[2]);
    applied.push(key);
  }
  return { applied, shadowed };
}
