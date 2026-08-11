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
        // admin-list も同じ。問い合わせと整形だけで、判断を持たない（B-7）。
        // 判断を持つ集計は admin-counts.ts の toBlogCounts に切り出してあり、
        // そちらはユニットテストで数える
        '**/admin-list.ts',
        // 以下は repository と同じ理由（DBか外部への呼び出しそのもの）だが、
        // 名前が repository.ts ではないため個別に挙げる。**判断を持つ部分は
        // 別ファイルへ切り出してあり、そちらはユニットテストで数える。**
        //
        // | 除外 | 判断を持つ相方 | 検証している統合テスト |
        // |---|---|---|
        // | settings/service.ts | catalog.ts / mask.ts | settings.test.ts |
        // | settings/resolve.ts | — | settings.test.ts |
        // | settings/provider.ts | — | settings-wiring.test.ts |
        // | settings/connection-test.ts | — | settings-connection-test.test.ts |
        // | content-planning/service.ts | step1.ts | genre-review.test.ts |
        // | content-planning/step2-service.ts | step2.ts | offer-scoring.test.ts |
        // | content-planning/step3-service.ts | step3.ts | revenue-articles.test.ts |
        // | content-planning/step4-service.ts | step4.ts | traffic-articles.test.ts |
        // | content-planning/plan-builder.ts | constraints.ts / publish-order.ts | plan-builder.test.ts |
        // | content-generation/generate.ts | article.ts | article-generation.test.ts |
        // | content-generation/article-repository.ts | — | article-generation.test.ts |
        // | content-generation/ai.ts | article.ts | article-generation.test.ts |
        // | content-generation/claim-extraction.ts | fact-check.ts | article-generation.test.ts |
        // | content-generation/fact-check-service.ts | fact-check.ts | article-generation.test.ts |
        // | content-generation/risk-flag-service.ts | risk-flags.ts | article-generation.test.ts |
        // | content-generation/approvable.ts | — | proposals.test.ts |
        // | approvals/propose.ts | priority.ts | proposals.test.ts |
        // | line/notify.ts | message.ts | line-notification.test.ts |
        // | lib/line/messaging.ts | — | line-notification.test.ts |
        // | line/alerts.ts | judgeConnectionAlert は同ファイルの純粋関数 | emergency-alerts.test.ts |
        // | analytics/weekly-result.ts | normalizeWeeklyResult は同ファイルの純粋関数 | weekly-results.test.ts |
        // | analytics/search-console.ts | normalizePropertyUrl は同ファイルの純粋関数 | search-console-connect.test.ts |
        // | affiliate/link-check.ts | judgeLinkHealth は同ファイルの純粋関数 | emergency-alerts.test.ts |
        // | approvals/detail.ts | — | proposals.test.ts |
        // | approvals/decide.ts | — | approval-decisions.test.ts |
        // | users/admin-status.ts | 遷移表の判定は同ファイルの純粋関数 | monitor-status.test.ts |
        // | users/withdrawal.ts | — | withdrawal.test.ts |
        // | content-planning/plan-repository.ts | — | revenue-articles.test.ts |
        // | affiliate/scoring.ts | step2.ts | offer-scoring.test.ts |
        // | content-planning/ai.ts | step1.ts の filterAlternatives | genre-review.test.ts |
        'src/modules/settings/service.ts',
        'src/modules/settings/resolve.ts',
        'src/modules/settings/provider.ts',
        'src/modules/settings/connection-test.ts',
        'src/modules/content-planning/service.ts',
        'src/modules/content-planning/step2-service.ts',
        'src/modules/content-planning/step3-service.ts',
        'src/modules/content-planning/step4-service.ts',
        'src/modules/content-planning/plan-builder.ts',
        'src/modules/content-generation/generate.ts',
        'src/modules/content-generation/article-repository.ts',
        'src/modules/content-generation/ai.ts',
        'src/modules/content-generation/claim-extraction.ts',
        'src/modules/content-generation/fact-check-service.ts',
        'src/modules/content-generation/risk-flag-service.ts',
        'src/modules/content-generation/approvable.ts',
        'src/modules/approvals/propose.ts',
        'src/modules/line/notify.ts',
        'src/lib/line/messaging.ts',
        'src/modules/line/alerts.ts',
        'src/modules/analytics/weekly-result.ts',
        'src/modules/analytics/search-console.ts',
        'src/modules/affiliate/link-check.ts',
        'src/modules/approvals/detail.ts',
        'src/modules/approvals/decide.ts',
        'src/modules/users/withdrawal.ts',
        'src/modules/content-planning/plan-repository.ts',
        'src/modules/affiliate/scoring.ts',
        'src/modules/content-planning/ai.ts',
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
