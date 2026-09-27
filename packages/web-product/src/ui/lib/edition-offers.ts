import { isOperationComposed } from '@aflow/schemas';

import type { Edition } from '../hooks/useEdition.js';

/**
 * What a surface may offer, given the lanes this deployment composes.
 *
 * A control for a lane that is absent is worse than no control: the page
 * renders, the form submits, and the API is right to refuse — the operator
 * configured something nothing here can run. So the question is asked of the
 * lane, through the same derivation the Store filters its listings by, and not
 * of a surface name: the routes behind these controls are registered in both
 * editions and decline at runtime, so a surface gate is permanently true and
 * answers a different question.
 */

/**
 * The operation a repository designation exists to serve.
 *
 * A designation fixes the remote, branch policy and credential a managed coding
 * run may use. Without that lane there is nothing to fix them for.
 */
const REPO_DESIGNATION_OPERATION = 'code.agent.run';

/**
 * Whether repository designations can be created and used here.
 *
 * Closed while the edition is unknown: a control that appears a beat late is a
 * flicker, one that appears and then cannot run is a dead end.
 */
export function isRepoDesignationOffered(edition: Edition): boolean {
  return edition.lanes !== null && isOperationComposed(REPO_DESIGNATION_OPERATION, edition.lanes);
}
