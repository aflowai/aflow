/**
 * SpaceGate — space_id validation.
 *
 * The effective space is the explicit `space_id` passed to each tool. There is no
 * session default and no `set_space`: every space-scoped call states its space, so
 * an agent can never inherit a stale/wrong default and silently act in the wrong
 * space. (Pinning a single space so an agent CANNOT choose another is a separate,
 * deliberate config-level override — not a silent default — and is not built here.)
 */

export class SpaceGate {
  /**
   * Validate that an explicit space_id was supplied and return it.
   * @throws SpaceRequiredError if absent/empty.
   */
  resolve(inputSpaceId: string | undefined): string {
    if (!inputSpaceId) {
      throw new SpaceRequiredError();
    }
    return inputSpaceId;
  }
}

export class SpaceRequiredError extends Error {
  readonly code = 'SPACE_REQUIRED';
  readonly hint =
    'Pass space_id explicitly in this tool call. Call space_list to discover available ' +
    'spaces. If unsure which space to use, ask the user.';

  constructor() {
    super('space_id is required.');
    this.name = 'SpaceRequiredError';
  }
}
