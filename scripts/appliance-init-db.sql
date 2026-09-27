-- =============================================================================
-- Aflow Local — database initialization
-- =============================================================================
-- Runs once, when the appliance's PostgreSQL volume is first created.
--
-- Extensions only. Every table comes from the migrations `release.mjs` applies,
-- and the single tenant comes from `bootstrap` — unlike the development
-- init script, which seeds a well-known tenant this edition must not carry.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
