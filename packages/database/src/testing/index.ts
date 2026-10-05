/**
 * Test support, not runtime API: a Postgres backend in memory, for testing
 * what a real postgres.js client does when its connection closes. Published
 * because the orchestrator's recovery is tested against it as well.
 */
export * from './abruptClose.js';
export * from './fakePostgres.js';
