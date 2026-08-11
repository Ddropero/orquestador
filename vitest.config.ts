import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // Los tests contra APIs reales viven en *.live.test.ts y se corren aparte:
    // un test de red que falla por falta de red no dice nada sobre el código.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
  },
  resolve: {
    alias: {
      '@evidentia/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@evidentia/search': new URL('./packages/search/src/index.ts', import.meta.url).pathname,
      '@evidentia/verify': new URL('./packages/verify/src/index.ts', import.meta.url).pathname,
      '@evidentia/sources': new URL('./packages/sources/src/index.ts', import.meta.url).pathname,
    },
  },
});
