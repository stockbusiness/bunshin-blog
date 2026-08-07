import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
};

/**
 * ユニットテストと画面テストをまとめて動かす（A-5・B-9）。
 *
 * **実行環境が違うため project を分ける。** ロジックは `node` で走らせる
 * （`Response` など Node の実装をそのまま使いたい）。画面は DOM が要るので
 * `jsdom` で走らせる。全体を `jsdom` にすると、DOM を必要としない
 * テストまで遅くなり、`fetch` 周りの実装も差し替わる。
 *
 * 統合テストは実DBを要するため別設定（`vitest.integration.config.ts`）。
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['src/tests/integration/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['src/tests/**/*.test.tsx'],
          setupFiles: ['./src/tests/setup/component.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // 計測対象はロジックを持つコードのみ。**画面（`src/app/**`）は
      // component project で検証しているが、ここでは数えない。**
      // `src/app` にはRoute Handlerも含まれ、そちらは実DBの統合テストで
      // 検証しているため、まとめて含めると実態と合わない数字になる
      include: ['src/lib/**/*.ts', 'src/modules/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        // repository はDBへの問い合わせそのもの。所有権の条件が効いているかは
        // fake では確かめられないため、実DBに対する統合テストで検証する
        // （npm run test:integration）。ここで数えると、実際には検証済みの
        // コードを「未カバー」として扱うことになる
        '**/repository.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
