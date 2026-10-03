/**
 * What a run is told when an address is refused because of where it is.
 *
 * A profile that keeps sign-ins does not reach services on this machine: the
 * local edition's web application presents the instance secret to whoever
 * reaches its port, so a page loaded from it is the owner's Action Center and
 * an agent able to drive it could approve its own requests. An ephemeral
 * profile holds no sign-ins and is refused the same, except on the loopback
 * ports the operator declared for its harness, and reaches nothing its harness
 * may not. The egress proxy enforces both on every connection.
 */
import { isEphemeralBrowserProfileId } from '@aflow/schemas';

type When = 'asked' | 'connecting';

function outcome(when: When): string {
  return when === 'asked'
    ? 'Nothing was opened.'
    : 'The connection was refused, so the page did not load there.';
}

export function localDestinationRefusal(profileId: string, reason: string, when: When): string {
  const which = isEphemeralBrowserProfileId(profileId)
    ? 'reaches services on this machine only on the loopback ports the operator declared for ' +
      'its harness'
    : 'keeps sign-ins, so it does not reach services on this machine';
  return `Browser profile \`${profileId}\` ${which}: ${reason}. ${outcome(when)}`;
}

export function reachRefusal(profileId: string, reason: string, when: When): string {
  return (
    `Browser profile \`${profileId}\` reaches only what its harness may reach: ${reason}. ` +
    `${outcome(when)} A harness's reach is set on the machine, with \`aflow harness\`.`
  );
}
