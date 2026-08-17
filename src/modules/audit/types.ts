/**
 * 監査ログの語彙（TASKS H-11、SPEC 5.20、Q-018）。
 *
 * ## 何を残すのか（SPEC 14.4 の8種類）
 *
 * | 項目 | 状態 |
 * |---|---|
 * | ログイン | **H-13** |
 * | WordPress接続変更 | H-12 |
 * | 案件URL変更 | **H-13** |
 * | 承認 | H-12 |
 * | 公開 | H-12 |
 * | 管理者介入 | H-1 |
 * | ジョブ再実行 | **H-14** |
 * | AIプロンプト変更 | H-13 |
 *
 * **8種類が揃った**（2026-08-12）。ジョブ再実行は H-13 の時点で
 * 機能そのものが無く（cron が消化するだけだった）、**無い操作は
 * 記録できない**ため、機能を作る H-14 で一緒に足した。
 *
 * 加えて SPEC 9.2.2 の「承知で進める」（14.4 の一覧には無い）。
 *
 * H-11 は「**普通ではないことが起きた**」記録だけを入れていたが、
 * SPEC 14.4 は**正常系のうち後から辿れないと困るもの**も求めている
 * （Q-027）。**承認と公開が最も重い** — 実験の結果を振り返るとき、
 * 誰がいつ何を通したかが分からないと検証できない。
 *
 * それでも**全ての正常系を残すログにはしない。** 全部残すと、
 * 後から見たときに異常が埋もれる。
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
  /** ADMIN がモニターを退会させた（H-4）。**戻せない** */
  'MONITOR_WITHDRAWN',
  /** ADMIN がブログの接続先を変えた（Q-008 の救済手順） */
  'BLOG_SITE_URL_CHANGED',
  /** モニターが提案を承認した（H-12、SPEC 14.4「承認」） */
  'ARTICLE_APPROVED',
  /**
   * 記事を WordPress へ送った（H-12、SPEC 14.4「公開」）。
   *
   * **Phase 0 で作るのは下書きだけ**（SPEC 7）。公開はモニターが
   * WordPress 側で行うので、こちらが記録できるのはここまで
   */
  'ARTICLE_POSTED',
  /** WordPress の接続情報を登録・更新した（H-12、SPEC 14.4） */
  'WORDPRESS_CONNECTED',
  /** WordPress の接続を切った（H-12、SPEC 14.4） */
  'WORDPRESS_DISCONNECTED',
  /** モニターが LIFF でログインした（H-13、SPEC 14.4「ログイン」） */
  'USER_LOGGED_IN',
  /** ADMIN がログインリンクでログインした（H-13、SPEC 14.4） */
  'ADMIN_LOGGED_IN',
  /**
   * 案件のURLが変わった（H-13、SPEC 14.4「案件URL変更」）。
   *
   * **リンク先が変われば、記事から読者が行く先が変わる。**
   * 成果の計上にも関わるので、いつ誰が変えたかを残す
   */
  'OFFER_URL_CHANGED',
  /** AIプロンプトの版を作った（H-13、SPEC 14.4「AIプロンプト変更」） */
  'PROMPT_VERSION_CREATED',
  /** AIプロンプトの版を有効化した（H-13、SPEC 14.4） */
  'PROMPT_VERSION_ACTIVATED',
  /**
   * インデックス率の見直しで週の公開上限が変わった（G-8b、W-8）。
   *
   * **人が押した操作ではない**ので `actor_user_id` は `null`。
   * 専用のテーブルを作らず、**ブログに対する自動的な介入**として
   * ここに残す（管理画面はこれを読む）
   */
  'PUBLISH_CAP_ADJUSTED',
  /**
   * ADMIN が失敗したジョブを積み直した（H-14、SPEC 14.4「ジョブ再実行」）。
   *
   * **中断の印を消したかも残す。** 消した場合は
   * **外部の副作用が二重になりうる**（C-4）
   */
  'JOB_RETRIED',
  /**
   * 分身が2体以上あって、LINEの返信をどれの記憶にするか決められなかった
   * （Q-037、2026-08-17 の決定）。
   *
   * **保存できなかったことを残す。** これを数えないと、
   * 「LINE上で分身を選ばせる」へ移る判断ができない
   * （**移る条件は「未保存が継続的に多いこと」**）。
   *
   * **正常系ではない** — 本人は答えたのに、こちらが受け取れていない
   */
  'REPLY_NOT_SAVED',
  /**
   * 成果CSVで、案件名から振り分けられず人が割り当てた
   * （Q-059、2026-08-17 の決定）。
   *
   * **割り当てが要った回だけ残す。** 要らなかった回は正常系なので
   * 残さない（`audit_logs` は「普通ではないこと」の置き場）。
   *
   * **割当記憶を実装する条件**（未割当が2週連続で全体の20%以上、
   * または手動割当が週10件以上）を、ここから数える
   */
  'RESULT_ASSIGNED_BY_HAND',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 記録の対象（SPEC 5.20 の `entity_type`） */
export const AUDIT_ENTITY_TYPES = [
  'user',
  'blog',
  'planning_run',
  /** 承認（H-12） */
  'approval',
  /** 記事（H-12。投稿の対象） */
  'content_item',
  /** 案件（H-13） */
  'affiliate_offer',
  /** AIプロンプトの版（H-13） */
  'prompt_version',
  /** ジョブ（H-14） */
  'job',
] as const;

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
