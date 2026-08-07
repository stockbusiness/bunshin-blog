import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'src/**/*.test.ts'],
    // 統合テストは実DBを要するため、別設定（vitest.integration.config.ts）で動かす
    exclude: ['src/tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // 計測対象はロジックを持つコードのみ。画面と設定は対象外にする
      include: ['src/lib/**/*.ts', 'src/modules/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
