/**
 * LIFF のブラウザ側基盤（B-8）。
 *
 * **サーバー専用のモジュールを import しない。** `src/lib/` にはサーバー
 * 専用のもの（`db.ts` `env.ts`）とブラウザでも動くもの（`liff/`
 * `datetime.ts`）が混在する。ここから前者へ依存するとクライアント
 * コンポーネントのビルドが壊れる（MODULE_RULES 4）。
 */

export { readLiffConfig, LIFF_ID_ENV_NAME } from './config';
export type { LiffConfigResult } from './config';

export { bootstrapLiffSession } from './bootstrap';
export type {
  LiffClient,
  LiffBootstrapResult,
  LiffSessionUser,
  LiffSessionConsents,
  BootstrapLiffSessionOptions,
} from './bootstrap';
