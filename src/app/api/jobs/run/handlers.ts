import type { JobHandlerRegistry } from '@/modules/jobs';

/**
 * ジョブの種類とハンドラの対応（TASKS E-1）。
 *
 * **登録は `src/app/` 側で行う**（MODULE_RULES 3）。`jobs` モジュールが
 * ドメインモジュールを import すると `jobs → wordpress → jobs` の
 * 循環になる。
 *
 * **登録されていない種類のジョブは取得されない。** ハンドラが無い種類を
 * 積んでも、`RUNNING` のまま残ることはなく `QUEUED` に留まる。
 *
 * 現時点で登録済みのハンドラは無い。以降のタスクでここへ足す。
 *
 * | 種類 | 追加するタスク |
 * |---|---|
 * | `WORDPRESS_POST` | F-7（承認からの投稿連携） |
 * | `WORDPRESS_SYNC` | C-5 |
 * | `PLAN_GENERATION` `ARTICLE_GENERATION` | E-4〜E-10 |
 * | `SEARCH_CONSOLE_FETCH` | G-2 |
 * | `LINE_NOTIFY` | F-2 |
 */
export const JOB_HANDLERS: JobHandlerRegistry = {};
