/**
 * A proposal route answers a proposal it cannot read with a 404 that says
 * why: missing, deleted, unparseable with the failing fields, or a refused
 * path. The card shows that sentence, so the operator never reads every
 * failure as a missing proposal.
 */
export function describeProposalReadFailure(status: number, body: unknown): string {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const error = typeof fields['error'] === 'string' ? fields['error'].trim() : '';
  const message = typeof fields['message'] === 'string' ? fields['message'].trim() : '';
  if (error && message) return `${error}: ${message}`;
  const detail = message || error;
  return `HTTP ${String(status)}${detail ? `: ${detail}` : ''}`;
}

export async function readProposalReadFailure(res: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return describeProposalReadFailure(res.status, body);
}
