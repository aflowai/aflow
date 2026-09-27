/**
 * Whether the Terms of Service govern this edition at all.
 *
 * They describe a relationship with a hosted service. An operator running an
 * instance on their own machine has no such relationship, so there is nothing
 * to require agreement to.
 *
 * Both the enforcement hook and the status `/users/me` reports read this, and
 * that matters: the client renders its consent card from the reported status
 * alone, so a server that stopped enforcing while still reporting `required`
 * would replace the dashboard with a wall nothing could clear.
 */
import type { EditionDescriptor } from '@aflow/schemas';

export function termsApply(edition: EditionDescriptor): boolean {
  return edition.edition === 'enterprise';
}
