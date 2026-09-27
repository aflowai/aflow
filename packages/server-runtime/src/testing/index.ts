/**
 * Test support, not runtime API.
 *
 * Minting an RS256 token and serving a JWKS document that matches it is the
 * machinery for testing any identity plane, and `identityPlane` is the contract
 * a distribution implements — so a distribution has to be able to test its
 * implementation. Published for that reason alone.
 *
 * It carries fixture detail a supported interface should not: `VERIFIED` is 503
 * because a request that clears authentication then fails downstream in the
 * harness. Narrowing this to the generic half is worth doing once a second
 * consumer exists to show which half that is.
 *
 * `vitest` is external to this package's bundle. It is a devDependency, which
 * tsup bundles by default, and a harness holding its own copy is not talking to
 * the runner that invoked the test — which surfaces as `Vitest failed to find
 * the runner` rather than as anything naming this file.
 */
export * from '../plugins/__tests__/authHarness.js';
