/**
 * analytics モジュールが外部へ渡す表現（TASKS D-8、SPEC 5.14）。
 *
 * 本タスクで扱うのは `link_clicks` のみ。`metrics_daily` は G-2、
 * `search_console_connections` は G-1。
 */

export interface AppLinkClick {
  id: string;
  affiliateLinkId: string;
  /** 参照元のホスト名。取れなければ `null` */
  referrerHost: string | null;
  /**
   * AI検索サービス経由か（SPEC 11.4）。
   *
   * **D-8 では常に `false`。** 判別は G-4 の担当で、対象ドメインを
   * 設定ファイルで追加できる形にする。**`referrer_host` を残してあるので
   * 後から数え直せる。**
   */
  isAiReferral: boolean;
  /** UAのハッシュ。生の値は保存しない */
  userAgentHash: string | null;
  clickedAt: Date;
}

export interface RecordClickInput {
  affiliateLinkId: string;
  /** `Referer` ヘッダーの生の値 */
  referrer?: string | null | undefined;
  /** `User-Agent` ヘッダーの生の値 */
  userAgent?: string | null | undefined;
}
