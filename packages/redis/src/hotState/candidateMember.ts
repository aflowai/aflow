/**
 * `tenantId:sessionId` — the member encoding every session-keyed candidate
 * index shares, so a repair pass holding only a member can address the session
 * hash it stands for.
 */
export function sessionCandidateMember(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

export function parseSessionCandidateMember(
  member: string,
): { tenantId: string; sessionId: string } | null {
  const idx = member.indexOf(':');
  if (idx <= 0 || idx === member.length - 1) return null;
  return { tenantId: member.slice(0, idx), sessionId: member.slice(idx + 1) };
}
