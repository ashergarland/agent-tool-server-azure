import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      // Entry points wire the process together and are covered by the Docker smoke test instead;
      // the Azure adapters are exercised against a live control plane, not in this suite.
      exclude: [
        'src/index.ts',
        'src/mcp/stdio.ts',
        'src/provider/azure/**',
        'src/deployments/store-azure.ts',
        'src/util/logger.ts',
      ],
      // Set just under the current numbers so an ordinary change does not fail the build, but a
      // meaningful drop does. Branch coverage is lower by design: much of it is the
      // `value === undefined ? {} : { value }` idiom used to honour exactOptionalPropertyTypes.
      thresholds: {
        lines: 88,
        statements: 86,
        functions: 85,
        branches: 70,
      },
    },
  },
});
