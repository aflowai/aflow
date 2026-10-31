/**
 * Where a picker tile posts the profile it names (Plan 335 P3). The admission
 * check in `proxy.ts` has already refused a post from another origin.
 */
import { answerProfileChoice } from '@/compose/localProfileSession';

export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return answerProfileChoice(request);
}
