/**
 * Compile a submitted artifact — this application's entry point over the product.
 *
 * Next resolves route files at build time, so a handler has to exist here. What
 * it does is `@aflow/web-product`; who may ask is the composed identity.
 */
import type { NextRequest } from 'next/server';
import { handleCompileRequest } from '@aflow/web-product/compiler';

import { localWebIdentity } from '@/compose/localWebIdentity';

export const runtime = 'nodejs';

export const POST = (request: NextRequest): Promise<Response> =>
  handleCompileRequest(request, localWebIdentity);
