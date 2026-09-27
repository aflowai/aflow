import { describe, it, expect } from 'vitest';
import {
  ActionCenterItemKindSchema,
  ActionCenterAllowedActionSchema,
  ActionCenterAudienceSchema,
} from '@aflow/schemas';
import {
  ACTION_CENTER_ITEM_KINDS,
  ACTION_CENTER_ALLOWED_ACTIONS,
  ACTION_CENTER_AUDIENCES,
} from './use-action-center-types.js';

/**
 * The web keeps a hand-written mirror of the Action Center enums (to avoid
 * pulling `@aflow/schemas` into the client bundle). This guard fails the
 * moment the server union and the web mirror drift — the founding drift was
 * the web mirror missing `coach_activity`.
 */
describe('Action Center type lockstep (server union ↔ web mirror)', () => {
  it('item kinds match the server enum exactly', () => {
    expect([...ACTION_CENTER_ITEM_KINDS].sort()).toEqual(
      [...ActionCenterItemKindSchema.options].sort(),
    );
  });

  it('allowed actions match the server enum exactly', () => {
    expect([...ACTION_CENTER_ALLOWED_ACTIONS].sort()).toEqual(
      [...ActionCenterAllowedActionSchema.options].sort(),
    );
  });

  it('audiences match the server enum exactly', () => {
    expect([...ACTION_CENTER_AUDIENCES].sort()).toEqual(
      [...ActionCenterAudienceSchema.options].sort(),
    );
  });
});
