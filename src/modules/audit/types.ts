/**
 * 監査ログの語彙（TASKS H-11、SPEC 5.20、Q-018）。
 *
 * ## 何を残すのか
 *
 * SPEC が `audit_logs` への記録を求めているのは2か所。
 *
 * | 箇所 | 内容 |
 * |---|---|
 * | SPEC 9.2.2 | 停止条件を**承知で進めた**選択（E-4） |
 * | Q-008 の決定 | ADMIN による介入 |
 *
 * どちらも「**普通ではないことが起きた**」記録である。正常系を全部
 * 残すログではない — 全部残すと、後から見たときに異常が埋もれる。
 *
 * ## `action` を文字列の自由入力にしない
 *
 * 列は `text` だが、**書く側が好きな語を入れると集計できない。**
 * ここに並べたものだけを使う。
 *
 * DBも外部も触らない純粋な定義。
 */

/** 記録する行為（SPEC 5.20 の `action`） */
export const AUDIT_ACTIONS = [
  /** 停止条件を承知でジャンルを進めた（SPEC 9.2.2、E-4） */
  'GENRE_BLOCK_OVERRIDDEN',
  /** ADMIN がモニターの参加を承認した（H-1） */
  'MONITOR_ACTIVATED',
  /** ADMIN がモニターを停止した（H-1） */
  'MONITOR_PAUSED',
  /** ADMIN がモニターの利用を再開した（H-1） */
  'MONITOR_RESUMED',
  /** ADMIN がブログの接続先を変えた（Q-008 の救済手順） */
  'BLOG_SITE_URL_CHANGED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 記録の対象（SPEC 5.20 の `entity_type`） */
export const AUDIT_ENTITY_TYPES = ['user', 'blog', 'planning_run'] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AppAuditLog {
  id: string;
  /** 行為者。システムが自動で行った場合は `null`（SPEC 5.20） */
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface RecordAuditInput {
  /**
   * 行為者。
   *
   * **本人の操作でも記録する。** 「承知で進める」はモニター自身の選択で、
   * ADMIN の介入とは別物だが、どちらも後から辿れる必要がある。
   */
  actorUserId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  /**
   * 補足。
   *
   * **秘密を入れない**（SPEC 14.2）。APIキー・認証情報・LINEのユーザーIDは
   * 入れてはならない。入れてよいのは「何が起きたか」を後から読むための値。
   */
  metadata?: Record<string, unknown> | undefined;
}
