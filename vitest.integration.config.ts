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
/**
 * アプリのコードは `getServerEnv()` で**全ての**必須変数を検証する。
 * 統合テストで必要なのは `DATABASE_URL` だけだが、それ以外も揃っていないと
 * 起動時検証で落ちる。**テスト用のダミーをここで補う。**
 *
 * `DATABASE_URL` にはダミーを置かない。未設定のときは
 * `helpers/db.ts` が設定方法を示して落ちる方が親切なため。
 */
function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LINE_LOGIN_CHANNEL_ID: process.env['LINE_LOGIN_CHANNEL_ID'] ?? '1234567890',
    SESSION_SECRET: process.env['SESSION_SECRET'] ?? 'x'.repeat(48),
    // base64 の32バイト（AES-256-GCM・C-1）。テスト専用の固定値
    ENCRYPTION_KEY:
      process.env['ENCRYPTION_KEY'] ??
      'dGVzdC1vbmx5LWtleS1mb3ItY2ktMzItYnl0ZXMhISE=',
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    env: testEnv(),
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
