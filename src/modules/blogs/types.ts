import type { ArticleRatio } from './article-ratio';

/** ブログに割り当てられたジャンル。決まるのは E-4 の審査（Q-009） */
export interface AppBlogGenre {
  id: string;
  name: string;
  category: string;
}

/**
 * `genres` マスタの1件（E-4）。
 *
 * **利用者に紐づかない。** システム全体で1組のマスタで、`ymyl_risk` は
 * ここが唯一の正（利用者の申告で上書きしない。SPEC 9.2.2）。
 */
export interface AppGenre extends AppBlogGenre {
  ymylRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'CANDIDATE' | 'APPROVED' | 'REJECTED';
}

/**
 * blogs モジュールが外部へ渡すブログ表現（B-3）。
 *
 * Prisma の型をそのまま外へ出さない（users と同じ方針）。
 */
export interface AppBlog {
  id: string;
  userId: string;
  /**
   * どの分身の媒体か（A-2-R-2c）。
   *
   * **A-2-R-3 で `NOT NULL` になる。** それまでは A-2-R-2c 以前に
   * 作られたブログが `null` を持ちうる。
   */
  personaId: string | null;
  name: string;
  slug: string;
  targetReader: string;
  penName: string | null;
  purpose: 'AFFILIATE' | 'DISPLAY_AD' | 'MIXED';
  status: 'SETUP' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
  slotNumber: number;
  launchDate: Date | null;
  createdAt: Date;
  /** 記事構成。`weeklyPublishCap` 以外は算出値（B-5・Q-011） */
  articleRatio: ArticleRatio;
  /** 未審査なら `null`。設定画面では表示のみ（Q-009） */
  genre: AppBlogGenre | null;
}

/**
 * 新規作成の入力。`userId` は含めない（セッションから取る）。
 *
 * `slotNumber` は省略できる。省略すると空いている最小の番号が割り当てられる
 * （B-4）。クライアントは `CLOSED` を含む使用状況を持たないため、
 * 自力で空きを決められない。
 */
export interface CreateBlogInput {
  /**
   * どの分身の媒体か（A-2-R-2c）。**必須。**
   *
   * **持ち主の確認は `blogs` からはできない。** 依存の向きが
   * `personas → blogs`（MODULE_RULES）で循環するため。
   * 他人の分身IDは**DBの複合外部キー**が拒む（A-2-R-2c-schema）。
   */
  personaId: string;
  name: string;
  slug: string;
  targetReader: string;
  slotNumber?: number | undefined;
  penName?: string | undefined;
  purpose?: AppBlog['purpose'] | undefined;
}

/**
 * 更新の入力。指定した項目のみ変える。
 *
 * **`genre` と `article_ratio.revenue` / `traffic` は含めない。**
 * 前者は E-4 の審査で決まり（Q-009）、後者は算出値（Q-011）。
 *
 * **`personaId` も含めない**（A-2-R-2c）。付け替えると、
 * それまでに書いた記事の書き手が後から変わる。**同じブログの記事が
 * 途中で別人になったのか、同じ人が変わったのかを区別できなくなり、
 * 実験の一次データが読めなくなる。** 別の分身で書くなら別のブログを作る。
 */
export interface UpdateBlogInput {
  name?: string | undefined;
  slug?: string | undefined;
  targetReader?: string | undefined;
  penName?: string | null | undefined;
  purpose?: AppBlog['purpose'] | undefined;
  status?: Exclude<AppBlog['status'], 'CLOSED'> | undefined;
  /** 週の公開上限（1〜4）。`article_ratio` の他の項目は保持される */
  weeklyPublishCap?: number | undefined;
}
