/**
 * 日時ヘルパー（TASKS A-7）。
 *
 * `docs/DATA_MODEL.md` 10章に従う。
 * - 保存は `timestamptz`（内部的にUTC）
 * - 業務上の基準時刻は JST（Asia/Tokyo）
 * - 週の開始は月曜
 *
 * **各モジュールで独自に日付計算を書かない。** 日付境界・週境界の判定は
 * 必ずここを経由する。`new Date()` からの手計算や、モジュールごとの
 * オフセット加算を禁止する。
 *
 * JSTは夏時間を持たないため、固定オフセット（UTC+9）で計算する。
 * 対象期間に切り替えは無く、`Intl` に依存しない分だけ結果が決定的になる。
 */

export const JST_TIME_ZONE = 'Asia/Tokyo';

/** JSTのUTCからのオフセット（分） */
export const JST_OFFSET_MINUTES = 9 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const JST_OFFSET_MS = JST_OFFSET_MINUTES * MS_PER_MINUTE;

/**
 * JSTの暦日を表す `YYYY-MM-DD`。
 *
 * `metrics_daily.metric_date` など `date` 型の列に対応する
 * （DATA_MODEL 10章「日付型のカラムはJSTの暦日として扱う」）。
 */
export type JstDate = string;

/** JSTの壁時計時刻を表す `HH:MM` または `HH:MM:SS` */
export type JstTime = string;

/** 日付境界の区間。`start` 以上 `endExclusive` 未満 */
export interface InstantRange {
  start: Date;
  endExclusive: Date;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** `YYYY-MM-DD` として妥当か。存在しない日付（2026-02-30 など）は false */
export function isJstDate(value: string): boolean {
  const matched = DATE_PATTERN.exec(value);
  if (matched === null) {
    return false;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));

  // 繰り上がった場合は存在しない日付
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

function assertJstDate(value: string): void {
  if (!isJstDate(value)) {
    throw new Error(`JSTの日付として不正です: ${value}（YYYY-MM-DD 形式）`);
  }
}

function assertValidInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new Error('Invalid Date が渡されました');
  }
}

/**
 * UTCの瞬間を、その時点のJSTの暦日に変換する。
 *
 * 外部APIがUTC基準のタイムスタンプを返す場合も、これを通してから
 * `date` 列に保存する（DATA_MODEL 10章）。
 */
export function toJstDate(instant: Date): JstDate {
  assertValidInstant(instant);

  const shifted = new Date(instant.getTime() + JST_OFFSET_MS);

  return [
    pad(shifted.getUTCFullYear(), 4),
    pad(shifted.getUTCMonth() + 1),
    pad(shifted.getUTCDate()),
  ].join('-');
}

/** JSTの暦日の 00:00 を表すUTCの瞬間を返す */
export function startOfJstDay(date: JstDate): Date {
  assertJstDate(date);

  const matched = DATE_PATTERN.exec(date) as RegExpExecArray;
  const utcMidnight = Date.UTC(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
  );

  return new Date(utcMidnight - JST_OFFSET_MS);
}

/**
 * `date` 型の列へ入れる値を作る（OPEN_QUESTIONS Q-031）。
 *
 * **`startOfJstDay` を `date` 型の列へ渡してはならない。** あちらが返すのは
 * 「JSTの暦日の00:00を表すUTCの瞬間」で、`2026-08-11` に対して
 * `2026-08-10T15:00Z` になる。`date` 型の列はこの値の**UTCの日付部分**を
 * 取るため、**1日前の日付が保存される。**
 *
 * ```
 * startOfJstDay('2026-08-11')  → 2026-08-10T15:00Z → date 列には 2026-08-10
 * jstDateColumn('2026-08-11')  → 2026-08-11T00:00Z → date 列には 2026-08-11
 * ```
 *
 * `date` 型の列は時刻を持たない。**暦日そのものを渡す**のが正しく、
 * タイムゾーンの変換をしてはいけない。
 *
 * 使い分け：
 *
 * | 用途 | 使う関数 |
 * |---|---|
 * | `date` 型の列（`metrics_daily.metric_date`） | **`jstDateColumn`** |
 * | `timestamptz` の範囲検索 | `startOfJstDay` / `jstDayRange` |
 */
export function jstDateColumn(date: JstDate): Date {
  assertJstDate(date);

  const matched = DATE_PATTERN.exec(date) as RegExpExecArray;

  return new Date(
    Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])),
  );
}

/** JSTの1日の区間を返す。日次集計の抽出条件に使う */
export function jstDayRange(date: JstDate): InstantRange {
  const start = startOfJstDay(date);

  return {
    start,
    endExclusive: new Date(start.getTime() + MS_PER_DAY),
  };
}

/**
 * JSTの暦日と壁時計時刻から、UTCの瞬間を求める。
 *
 * `monitor_profiles.notification_time` はJSTの壁時計時刻で保存されるため、
 * 送信時刻を求めるときにこれを使う（DATA_MODEL 10章）。
 */
export function atJstTime(date: JstDate, time: JstTime): Date {
  const matched = TIME_PATTERN.exec(time);
  if (matched === null) {
    throw new Error(`JSTの時刻として不正です: ${time}（HH:MM 形式）`);
  }

  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  const seconds = matched[3] === undefined ? 0 : Number(matched[3]);

  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`JSTの時刻として不正です: ${time}`);
  }

  const startMs = startOfJstDay(date).getTime();

  return new Date(startMs + ((hours * 60 + minutes) * 60 + seconds) * 1_000);
}

/** JSTの暦日に日数を加算する。負の値で減算 */
export function addJstDays(date: JstDate, days: number): JstDate {
  if (!Number.isInteger(days)) {
    throw new Error(`日数は整数である必要があります: ${days}`);
  }

  const shifted = startOfJstDay(date).getTime() + days * MS_PER_DAY;

  return toJstDate(new Date(shifted));
}

/**
 * その日が属する週の月曜のJST暦日を返す。
 *
 * **週の開始は月曜**（DATA_MODEL 10章）。`planned_publish_week` の週番号も、
 * 週4本の上限判定の集計区間も、これで揃える。
 */
export function startOfJstWeek(date: JstDate): JstDate {
  assertJstDate(date);

  // getUTCDay: 0=日曜, 1=月曜, ... 6=土曜
  const dayOfWeek = new Date(
    startOfJstDay(date).getTime() + JST_OFFSET_MS,
  ).getUTCDay();

  // 月曜を0とした経過日数
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  return addJstDays(date, -daysSinceMonday);
}

/** その日が属する週（月曜〜日曜）の区間を返す */
export function jstWeekRange(date: JstDate): InstantRange {
  const start = startOfJstDay(startOfJstWeek(date));

  return {
    start,
    endExclusive: new Date(start.getTime() + 7 * MS_PER_DAY),
  };
}

/**
 * 2つの日付が何週離れているかを返す（月曜始まり）。
 *
 * 同じ週なら0。`to` が後の週なら正、前の週なら負。
 */
export function jstWeeksBetween(from: JstDate, to: JstDate): number {
  const fromMonday = startOfJstDay(startOfJstWeek(from)).getTime();
  const toMonday = startOfJstDay(startOfJstWeek(to)).getTime();

  return Math.round((toMonday - fromMonday) / (7 * MS_PER_DAY));
}

/**
 * 基準日を1週目としたときの週番号を返す（1始まり）。
 *
 * `content_items.planned_publish_week` に対応する。
 * SPEC 9.2.7 は「1〜2週目：収益記事」「3週目以降：集客記事を週4本」と
 * 定めており、この番号はブログの公開開始日を基準とした相対週である。
 */
export function jstWeekNumber(baseDate: JstDate, target: JstDate): number {
  return jstWeeksBetween(baseDate, target) + 1;
}

/** いま現在のJST暦日 */
export function todayInJst(now: Date = new Date()): JstDate {
  return toJstDate(now);
}

/**
 * その瞬間のJSTの「時」（`00`〜`23`、2桁）。
 *
 * **1時間ごとの冪等キーに使う**（I-2）。`YYYY-MM-DD` と組にすれば、
 * 「その日のその時間に一度だけ」が一意制約で表せる。
 *
 * **JSTのオフセットは1時間単位**（+09:00）なので、UTCの時と食い違うのは
 * 数字だけで、**区切りの位置は同じ**。それでもここを通すのは、
 * JSTの暦日と組で使うため — 日付だけJSTにして時をUTCで取ると、
 * 日付が変わる時刻に**同じ組が2回現れる**。
 */
export function jstHour(now: Date = new Date()): string {
  assertValidInstant(now);

  return pad(new Date(now.getTime() + JST_OFFSET_MS).getUTCHours());
}
