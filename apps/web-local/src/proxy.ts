/**
 * Next middleware — admission for every request.
 *
 * What each edition does lives in the composed identity; what stays here is the
 * framework's business: which paths are public, and the matcher Next must be
 * able to analyse statically.
 *
 * Admission runs first and for every path including the public ones. A local
 * instance authorizes on reachability, so a request arriving under a host or
 * origin this instance does not answer to must be refused before it reaches a
 * route — being public is not a reason to skip that.
 *
 * There is no session half. The instance secret is attached at the BFF
 * boundary, so nothing here has a cookie to refresh or a provider to consult.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { localWebIdentity } from '@/compose/localWebIdentity';

/**
 * Paths served without any credential involvement. The front door and the
 * static assets it needs: an operator who has not finished first run still has
 * to be able to load the page that tells them so.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/_next') ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$/.test(pathname)
  );
}

export async function proxy(request: NextRequest): Promise<Response> {
  // `api/identity` and `api/ui/compile` sit outside the catch-all BFF route, so
  // a check made only there would miss them.
  const admission = await localWebIdentity.admitRequest(request);
  if (admission.kind === 'refused') {
    return new NextResponse(admission.reason, { status: 403 });
  }
  if (admission.kind === 'unavailable') {
    return new NextResponse(admission.reason, { status: 503 });
  }

  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  return localWebIdentity.processRequest(request, 'app');
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)'],
};
