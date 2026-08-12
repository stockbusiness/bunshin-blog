import { createHash } from 'node:crypto';

/**
 * 公開スケジュールの割り当て（TASKS C-9、作業指示書 W-8）。
 *
 * DBも外部も触らない純粋な処理。
 *
 * ## なぜ散らすのか
 *
 * **全ブログの投稿ジョブが同一時刻に集中しないこと**（完了条件）。
 *
 * 1. **同一運営者による大量サイトの痕跡を残さない**（W-8 の根拠）。
 *    30ブログが毎週同じ曜日の同じ時刻に更新されると、外から並べたときに
 *    同じ仕組みで動いていることが分かる
 * 2. ジョブが一斉に走ると、AIの呼び出しもWordPressへの投稿も同時に詰まる
 *
 * ## 既存の行を読んで空きを探さない
 *
 * 「いちばん空いている枠」を選ぶには**全ユーザーのブログを横断して読む**
 * ことになる（MODULE_RULES 5）。それだけでなく、**同時に2件作られると
 * 両方が同じ「空き」を選ぶ。**
 *
 * 代わりに **`(userId, slotNumber)` から決まる値**を使う。
 *
 * - 横断参照が要らない
 * - 同時に作っても衝突しない
 * - **同じブログには何度計算しても同じ値**（マイグレーションの埋め方と揃う）
 *
 * 完全な均等割りにはならないが、**曜日3通り × 時刻6通り × ゆらぎ46通り**で
 * 重なる確率は十分に低い。ゆらぎがあるので、曜日と時刻が同じでも
 * 実行時刻は分かれる。
 *
 * ## ランダムにしない
 *
 * 作り直したときに別の値になると、**同じブログの公開時刻が変わる。**
 * 読者から見れば更新のリズムが崩れ、こちらから見れば
 * 「なぜ変わったか」を追えない。
 */

/**
 * 公開する曜日の組。
 *
 * **週2日。** 週の上限（`article_ratio.weeklyPublishCap`）は1〜4本なので、
 * 2日あれば足りる。**連続しない2日**にして、片方が失敗しても
 * その週のうちにもう一度機会があるようにする。
 */
export const PUBLISH_WEEKDAY_SETS: readonly (readonly number[])[] = [
  [1, 4], // 月・木
  [2, 5], // 火・金
  [3, 6], // 水・土
];

/**
 * 公開時刻の幅。**9時〜14時。**
 *
 * 早すぎると前夜のうちに生成が終わっていない。遅すぎるとその日のうちに
 * 読まれない。**深夜を選ばない**のは、失敗したときに気づくのが翌日に
 * なるため。
 */
export const PUBLISH_HOUR_MIN = 9;
export const PUBLISH_HOUR_COUNT = 6;

/** 実行時刻のゆらぎ（分）。0〜45（W-8） */
export const PUBLISH_JITTER_MAX_MIN = 45;

/** 初期記事数。28〜34（W-8。SPEC 9.3 の30本を中心に散らす） */
export const INITIAL_ARTICLE_MIN = 28;
export const INITIAL_ARTICLE_COUNT_RANGE = 7;

export const PERMALINK_PATTERNS = [
  'POSTNAME',
  'CATEGORY_POSTNAME',
  'BLOG_POSTNAME',
  'ARCHIVES_POST_ID',
] as const;

export type PermalinkPattern = (typeof PERMALINK_PATTERNS)[number];

/**
 * WordPress の設定画面に入れる文字列。
 *
 * **スラッグは英数字にする**（W-8）。日本語スラッグはURLエンコードで
 * 長大になり、共有されたときに読めない。
 */
export const PERMALINK_PATHS: Record<PermalinkPattern, string> = {
  POSTNAME: '/%postname%/',
  CATEGORY_POSTNAME: '/%category%/%postname%/',
  BLOG_POSTNAME: '/blog/%postname%/',
  ARCHIVES_POST_ID: '/archives/%post_id%/',
};

export interface PublishSchedule {
  /** 0=日〜6=土 */
  publishWeekdays: number[];
  /** `HH:MM`（JSTの壁掛け時計） */
  publishTime: string;
  publishJitterMin: number;
  permalinkPattern: PermalinkPattern;
  initialArticleCount: number;
}

/**
 * 種から 0 以上の整数を作る。
 *
 * **sha256 を使う。** `String.hashCode` のような単純な足し算だと、
 * 似た種（`user-1:1` と `user-1:2`）が近い値になり、**散らない。**
 */
function digit(seed: string, salt: string, modulo: number): number {
  const hash = createHash('sha256').update(`${seed}:${salt}`).digest();

  return hash.readUInt32BE(0) % modulo;
}

/**
 * 公開スケジュールを割り当てる。
 *
 * @param seed `(userId, slotNumber)` のように**ブログを一意に決める文字列**。
 *   IDはDBが採番するので、作る前には分からない
 */
export function assignPublishSchedule(seed: string): PublishSchedule {
  const weekdays =
    PUBLISH_WEEKDAY_SETS[digit(seed, 'weekday', PUBLISH_WEEKDAY_SETS.length)] ??
    PUBLISH_WEEKDAY_SETS[0];
  const hour = PUBLISH_HOUR_MIN + digit(seed, 'hour', PUBLISH_HOUR_COUNT);
  const pattern =
    PERMALINK_PATTERNS[digit(seed, 'permalink', PERMALINK_PATTERNS.length)] ??
    'POSTNAME';

  return {
    publishWeekdays: [...(weekdays ?? [])],
    publishTime: `${String(hour).padStart(2, '0')}:00`,
    // **0〜45分。** 曜日と時刻が同じブログ同士を、最後にもう一段ずらす
    publishJitterMin: digit(seed, 'jitter', PUBLISH_JITTER_MAX_MIN + 1),
    permalinkPattern: pattern,
    initialArticleCount:
      INITIAL_ARTICLE_MIN + digit(seed, 'count', INITIAL_ARTICLE_COUNT_RANGE),
  };
}

/** `HH:MM` を `time` 列へ入れる値にする（JSTの壁掛け時計のまま） */
export function toPublishTimeColumn(time: string): Date {
  const [hours, minutes] = time.split(':');

  return new Date(Date.UTC(1970, 0, 1, Number(hours), Number(minutes), 0, 0));
}

/** `time` 列の値を `HH:MM` へ戻す */
export function fromPublishTimeColumn(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}
