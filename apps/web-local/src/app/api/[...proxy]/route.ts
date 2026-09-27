/**
 * BFF proxy — this application's entry points over the shared transport.
 *
 * Next resolves route files at build time, so the handlers have to exist here.
 * Everything they do lives in `@aflow/web-product`, parameterised by the
 * identity this application composes, so the two applications cannot forward a
 * browser request differently.
 */
import type { NextRequest } from 'next/server';
import { proxyToApi, type TransportConfig } from '@aflow/web-product';

import { localWebIdentity } from '@/compose/localWebIdentity';

export const runtime = 'nodejs';

const transport: TransportConfig = {
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  // The local API pins one tenant and refuses a request naming another, so a
  // selector would fail every call rather than select anything — and with none
  // forwarded there is no default for it to fall back to.
  forwardTenantSelector: false,
};

const forward = (request: NextRequest): Promise<Response> =>
  proxyToApi(request, localWebIdentity, transport);

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
