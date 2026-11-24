import type { BundleSmokeFixtures } from '../mockRehearsalClient.js';
import { createAlpacaThesisTradingSmokeFixtures } from './alpacaThesisTrading.js';

/**
 * Each bundle's smoke fixtures, built fresh for every smoke run, because a
 * run's writes stay in its fixtures' document store.
 */
const SMOKE_FIXTURES: Readonly<Record<string, () => BundleSmokeFixtures>> = {
  'alpaca-thesis-trading': createAlpacaThesisTradingSmokeFixtures,
};

export function getBundleSmokeFixtures(catalogId: string): BundleSmokeFixtures | null {
  return SMOKE_FIXTURES[catalogId]?.() ?? null;
}

/** Every bundle with smoke fixtures. */
export function listSmokedBundles(): string[] {
  return Object.keys(SMOKE_FIXTURES);
}
