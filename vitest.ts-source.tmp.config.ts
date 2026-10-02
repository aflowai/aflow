import { mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default mergeConfig(base, {
  ssr: { resolve: { conditions: ['ts-source', 'node', 'development|production'] } },
});
