/**
 * Returns the `resource_metadata` URL from a WWW-Authenticate header, or
 * `null` if none is present / the header is malformed.
 */
export function parseWwwAuthenticateResourceMetadata(
  header: string | null | undefined,
): string | null {
  if (!header) return null;

  // Split on commas that are NOT inside quoted strings. The header may carry
  // multiple challenges (e.g. `Bearer ..., Digest ...`). Per RFC 7235 each
  // challenge starts with a scheme token; params can be `key=value` or
  // `key="quoted"`.
  const challenges = splitChallenges(header);
  for (const challenge of challenges) {
    if (!/^Bearer\b/i.test(challenge.trim())) continue;
    const params = parseParams(challenge.replace(/^\s*Bearer\b/i, ''));
    const value = params['resource_metadata'];
    if (value) return value;
  }
  return null;
}

function splitChallenges(header: string): string[] {
  // Each challenge is `<scheme> <params>`. We split on commas that precede a
  // bare word followed by whitespace (i.e., the start of a new scheme). This
  // is a heuristic but covers the shapes ASes emit in practice.
  const parts: string[] = [];
  let depth = 0; // tracks quoted string nesting
  let buf = '';
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === '"') {
      depth = depth === 0 ? 1 : 0;
      buf += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      // Lookahead: is the next non-space token followed by a space (i.e., a
      // scheme name)? If yes, treat this comma as a challenge separator.
      const rest = header.slice(i + 1).trimStart();
      const isNewChallenge = /^[A-Za-z][\w-]*\s+/.test(rest);
      if (isNewChallenge) {
        parts.push(buf);
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim().length > 0) parts.push(buf);
  return parts;
}

function parseParams(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match `key=value` or `key="quoted"`; tolerate whitespace around `=`.
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? '';
    out[key] = value;
  }
  return out;
}
