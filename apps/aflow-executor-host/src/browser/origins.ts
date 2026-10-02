/**
 * The appliance's own pages, which a profile holding sign-ins does not open.
 *
 * The Action Center lives there: an agent able to drive it could approve its
 * own requests. This executor is told where Redis is and nothing else about
 * the appliance — pairing reads the API address and does not keep it — so the
 * appliance is recognised by the loopback ports the local edition serves its
 * API and web product on.
 */
export const APPLIANCE_LOOPBACK_PORTS: readonly string[] = ['3000', '3001'];

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function isApplianceOrigin(url: URL): boolean {
  return isLoopbackHost(url.hostname) && APPLIANCE_LOOPBACK_PORTS.includes(url.port);
}

export function applianceOriginRefusal(
  profileId: string,
  url: URL,
  reached: 'asked' | 'redirected',
): string {
  return (
    `Browser profile \`${profileId}\` keeps sign-ins, so it does not open this appliance's own ` +
    `pages (${url.origin}): the Action Center is there, and an agent able to use it could ` +
    'approve its own requests. ' +
    (reached === 'asked'
      ? 'Nothing was opened.'
      : 'The address asked for redirected there, and the page was closed.')
  );
}
