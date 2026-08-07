import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 統合テストの設定（TASKS A-9）。
 *
 * **実際のPostgreSQLへ接続する。** `DATABASE_URL` の指定が必須。
 * ユニットテスト（`vitest.config.ts`）とは別に動かす。
 *
 * 同一DBを共有するため**直列で実行する**。並列にすると、あるテストの
 * 後始末が別のテストのデータを消して、落ち方が実行順に依存する。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/tests/integration/**/*.test.ts'],
    // DBへの接続とマイグレーション適用ぶんの余裕を持たせる
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
    // カバレッジはユニットテスト側で測る
    coverage: { enabled: false },
  },
});
