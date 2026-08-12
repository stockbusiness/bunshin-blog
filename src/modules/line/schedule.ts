import { atJstTime, todayInJst } from '@/lib/datetime';

/**
 * 通知してよい時間帯の判定（TASKS F-3b、SPEC 8.3、OPEN_QUESTIONS Q-025）。
 *
 * DBも外部も触らない純粋な処理。
 *
 * ## なぜ「その時刻ちょうど」で判定しないか
 *
 * 送信はジョブから走る（E-1）。**ジョブが分単位で必ずその時刻に走る保証は
 * 無い。** 「07:00 ちょうど」でしか送らないと、少し遅れただけでその日は
 * 一度も届かない。
 *
 * **時刻から一定の幅を持たせる。** 幅を過ぎたら送らず、**翌日以降の
 * 通知日へ持ち越す**（Q-025）。夜中に届くくらいなら、翌朝のほうがよい。
 *
 * ## 未設定なら止めない
 *
 * `monitor_profiles` が無い、または曜日が空の人には**従来どおり送る**。
 * ここで止めると、**設定していないだけの人に通知が一切届かなくなる**
 * （F-3 までの挙動を、設定の有無で黙って変えない）。
 *
 * オンボーディングの段9で必ず設定してもらう（H-2b）。
 */

/**
 * 指定時刻から何分後まで送ってよいか。
 *
 * **3時間。** 「朝に届く」（SPEC 8.3）の範囲を保ちつつ、ジョブの遅れや
 * 一時的な失敗の再試行を吸収できる幅。これを超えたら翌日へ回す。
 */
export const NOTIFICATION_WINDOW_MINUTES = 180;

/**
 * 送れないまま何日置いたら期限切れにするか（Q-025）。
 *
 * **7日。** 曜日をどう絞っても、1日以上選んでいれば7日のうちに必ず
 * 通知日が来る（`normalizeNotificationSchedule` が0日を拒む）。
 * **それでも送れていない提案は、待っても送られない** — 1日に送れるのは
 * 1〜2件（SPEC 8.3）なので、後ろに積まれたものは順番が回ってこない。
 *
 * 消さずに `EXPIRED` にする。**提案が出たこと自体が実験の記録**で、
 * 「出したが送れなかった」と「そもそも出なかった」は別の事実。
 */
export const UNSENT_PROPOSAL_TTL_DAYS = 7;

export interface NotificationSchedule {
  /** `0` が日曜（`Date.getDay()` と揃える） */
  days: readonly number[];
  /** `HH:MM`（JSTの壁掛け時計） */
  time: string;
}

/**
 * いま送ってよいか。
 *
 * **JSTで判定する。** UTCで曜日を見ると、日本の朝9時が前日の0時に
 * なる日があり、**「月曜の朝」が日曜に判定される。**
 *
 * @param schedule 未設定なら `null`（そのときは常に送ってよい）
 */
export function isWithinNotificationWindow(params: {
  schedule: NotificationSchedule | null;
  now: Date;
}): boolean {
  const { schedule, now } = params;

  // **未設定なら止めない**（設定の有無で挙動を黙って変えない）
  if (schedule === null || schedule.days.length === 0) {
    return true;
  }

  const today = todayInJst(now);

  // JSTの曜日。**JSTの暦日そのものから取る** —
  // `now.getUTCDay()` にすると、日本の朝が前日として判定される
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();

  if (!schedule.days.includes(weekday)) {
    return false;
  }

  const start = atJstTime(today, schedule.time).getTime();
  const end = start + NOTIFICATION_WINDOW_MINUTES * 60 * 1_000;
  const at = now.getTime();

  // **開始前は送らない。** 「07:00 に届く」と決めた人へ 06:00 に送らない
  return at >= start && at < end;
}
