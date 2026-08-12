import { AppError } from '@/lib/errors';

/**
 * 通知の曜日と時刻の検証（TASKS H-2b、SPEC 8.3）。
 *
 * DBもネットワークも触らない純粋な処理。
 *
 * ## 時刻はJSTの壁掛け時計として持つ
 *
 * `monitor_profiles.notification_time` は `time`（タイムゾーンを持たない）。
 * **「21:00」と入れたら、JSTの21時**という約束にする。
 *
 * 保存のときは `1970-01-01T21:00:00.000Z` の形で渡す。**`Z` は入れ物の
 * 都合で、意味はJSTの壁掛け時計。** UTCへ直して入れると、読む側
 * （F-3b）が9時間ずらす処理を持つことになり、**ずらし忘れが必ず起きる。**
 */

/** 曜日。`0` が日曜（`Date.getDay()` と揃える） */
export const NOTIFICATION_DAY_MIN = 0;
export const NOTIFICATION_DAY_MAX = 6;

/** `HH:MM`。24時間表記 */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface NotificationSchedule {
  /** 昇順・重複なし。**1日以上** */
  days: number[];
  /** `HH:MM`（JSTの壁掛け時計） */
  time: string;
}

function invalid(message: string): AppError {
  return AppError.validationFailed(message);
}

/**
 * 入力を整える。
 *
 * **曜日が0件なら拒否する。** 保存はできるが通知が一度も飛ばない状態を
 * 作ると、**「設定済みなのに来ない」**という一番分かりにくい形になる。
 *
 * @throws {AppError} 曜日が空・範囲外、時刻の形が違う
 */
export function normalizeNotificationSchedule(
  input: unknown,
): NotificationSchedule {
  if (typeof input !== 'object' || input === null) {
    throw invalid('通知の設定を入力してください');
  }

  const record = input as Record<string, unknown>;
  const rawDays = record['days'];

  if (!Array.isArray(rawDays)) {
    throw invalid('通知する曜日を選んでください');
  }

  const days = [...new Set(rawDays)];

  for (const day of days) {
    if (
      typeof day !== 'number' ||
      !Number.isInteger(day) ||
      day < NOTIFICATION_DAY_MIN ||
      day > NOTIFICATION_DAY_MAX
    ) {
      throw invalid('通知する曜日が不正です');
    }
  }

  if (days.length === 0) {
    throw invalid('通知する曜日を1日以上選んでください');
  }

  const time = record['time'];

  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) {
    throw invalid('通知する時刻を HH:MM の形で入力してください');
  }

  return { days: (days as number[]).sort((a, b) => a - b), time };
}

/**
 * `HH:MM` を `time` 列へ入れる値にする。
 *
 * **`Z` は入れ物の都合。** 意味はJSTの壁掛け時計で、UTCへ直さない
 * （`jstDateColumn` と同じ考え方・Q-031）。
 */
export function toNotificationTimeColumn(time: string): Date {
  const matched = TIME_PATTERN.exec(time);

  if (matched === null) {
    throw invalid('通知する時刻を HH:MM の形で入力してください');
  }

  return new Date(
    Date.UTC(1970, 0, 1, Number(matched[1]), Number(matched[2]), 0, 0),
  );
}

/** `time` 列の値を `HH:MM` へ戻す */
export function fromNotificationTimeColumn(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}
