import type { z } from 'zod';

import { zodIssueMessage } from '@aflow/schemas';

/** Beyond this many, the rest of a policy's issues are counted rather than listed. */
const ISSUES_LISTED = 20;
/** A message longer than this is cut; the schema's own messages are far shorter. */
const ISSUE_CHARS = 2_000;

/**
 * What the schema refused, as `path: message` for each issue — the text the
 * operator needs to find the line in the file and the agent needs to say which.
 */
export function describePolicyIssues(error: z.ZodError): string {
  const listed = error.issues.slice(0, ISSUES_LISTED).map((issue) => {
    const where = issue.path.length === 0 ? '(top level)' : issue.path.join('.');
    const message = zodIssueMessage(issue);
    return `${where}: ${message.length > ISSUE_CHARS ? `${message.slice(0, ISSUE_CHARS)}…` : message}`;
  });
  const more = error.issues.length - listed.length;
  return `${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}
