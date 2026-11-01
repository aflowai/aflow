/**
 * The app's API key expires a year after setup minted it (Plan 327 D5), and the
 * operator hears so in Slack before it does: on each start inside the last two
 * weeks, and once it has expired.
 */
const NOTICE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function keyExpiryNotice(expiresAt: string | undefined, now: Date): string | undefined {
  if (expiresAt === undefined) return undefined;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return undefined;
  const day = new Date(at).toISOString().slice(0, 10);
  if (at <= now.getTime()) {
    return `The API key this channel uses expired on ${day}. Run \`yarn channel:slack setup\` to replace it.`;
  }
  if (at - now.getTime() > NOTICE_WINDOW_MS) return undefined;
  return `The API key this channel uses expires on ${day}. Run \`yarn channel:slack setup\` before then to replace it.`;
}
