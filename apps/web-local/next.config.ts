import type { NextConfig } from 'next';
import { securityHeaders } from '@aflow/web-product/next';

/**
 * The local application's configuration.
 *
 * Thin on purpose: what the product *is* lives in `@aflow/web-product`, and
 * this file says only which edition is being composed, which workspace sources
 * have to be compiled with it, and which origins this instance talks to.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@aflow/web-product'],

  // A dev server and a production build must not share an output directory: one
  // overwrites what the other is serving. Read from the environment rather than
  // argv, because the `next-server` child that loads this config is not the
  // process the flag was passed to — it inherits env and not argv.
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',

  // Off so a session's events reach the browser as they happen. Next's
  // compression buffers a response until it has enough to be worth compressing,
  // which for an event stream means holding each event until the next one
  // pushes it out. Nothing in front of this process compresses either — an
  // appliance has no CDN — so leaving it on would trade a stream for a stutter.
  compress: false,

  // esbuild carries a native binary no bundler can take, so Node requires it at
  // runtime in the route that compiles artifacts.
  serverExternalPackages: ['esbuild'],
  // The edition is fixed by the application rather than read from the
  // environment. A local build that could be told at runtime to behave as the
  // hosted one is a local build that has no boundary.
  env: { PHOENIX_EDITION: 'community-local' },

  /**
   * Report-only until an instance has reported: a policy assembled without
   * evidence breaks a page in ways only a browser shows. No additional sources —
   * an instance with nobody to turn away needs no challenge provider.
   *
   * `API_BASE_URL` is the key the API's own token route derives `realtimeUrl`
   * from, so naming it here is what keeps the socket's origin and the policy's
   * one value. It matters most where the API's origin is not otherwise stated:
   * every call then travels through this origin and passes under `'self'`, and
   * the socket — which the server hands over absolute — is the only thing left
   * outside the policy.
   */
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders({
          apiOrigin: process.env.NEXT_PUBLIC_API_ORIGIN,
          realtimeOrigin: process.env.API_BASE_URL,
          reportUri: process.env.CSP_REPORT_URI,
          enforce: process.env.CSP_ENFORCE === '1',
        }),
      },
    ];
  },
};

export default nextConfig;
