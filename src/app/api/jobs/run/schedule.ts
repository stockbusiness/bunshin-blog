import { todayInJst } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import {
  enqueueDailyAggregateForUser,
  enqueueIndexStatusForUser,
  enqueueSearchMetricsForUser,
} from '@/modules/analytics';
import { enqueueLinkCheckForUser } from '@/modules/line';
import { enqueueJob } from '@/modules/jobs';
import { listMonitorsForAdmin } from '@/modules/users';

/**
 * 日次ジョブの積み込み（TASKS I-1、SPEC 4.3）。
 *
 * ## なぜ必要だったのか
 *
 * 各タスクは「積む関数」まで作ったが、**それを呼ぶ人がいなかった。**
 * cron は `/api/jobs/run`（消化）1本だけで、**溜まったジョブは消化される
 * が、誰も積まない。** 本番へ出しても検索データも集計もリンク確認も
 * 動き出さない状態だった（棚卸し・2026-08-12）。
 *
 * ## 積む場所を `src/app/` に置く理由
 *
 * `analytics` `line` `users` を横断して呼ぶ（MODULE_RULES 3 の
 * 「上位へ寄せる」）。どれか1つのモジュールに置くと、そのモジュールが
 * 他のモジュールを知ることになる。
 *
 * ## 毎分の cron から呼ばれても重くしない
 *
 * **配るところ自体をジョブにする。** cron が呼ぶのは
 * 「今日ぶんの積み込みジョブを1件積む」だけで、`DAILY_SCHEDULE:<暦日>`
 * が既にあれば一意制約で弾かれる（C-4）。**1日1回だけ、利用者ぶんの
 * 積み込みが走る。**
 *
 * 直接ここで30ブログぶんを積もうとすると、毎分120件の挿入を試みることに
 * なる（そのほとんどが重複で捨てられる）。
 */

/**
 * 今日ぶんの積み込みジョブを積む。
 *
 * **JSTの暦日で1件。** 日付が変わるまで二度目は積まれない。
 *
 * @returns 新しく積んだなら `true`
 */
export async function enqueueDailySchedule(
  params: { now?: Date | undefined } = {},
): Promise<boolean> {
  const date = todayInJst(params.now ?? new Date());

  const result = await enqueueJob({
    jobType: 'DAILY_SCHEDULE',
    idempotencyKey: `DAILY_SCHEDULE:${date}`,
    input: {},
  });

  return result.created;
}

export interface DailyScheduleResult {
  /** 対象になった利用者の数 */
  users: number;
  /** 種類ごとに新しく積んだ件数 */
  queued: {
    searchMetrics: number;
    indexStatus: number;
    dailyAggregate: number;
    linkCheck: number;
  };
  /** 積めなかった利用者の数。**0でないことが分かるように返す** */
  failed: number;
}

/**
 * 利用者ごとの日次ジョブを積む（`DAILY_SCHEDULE` の中身）。
 *
 * **`ACTIVE` の利用者だけ。** 招待しただけ・停止中・退会済みの人の
 * ブログを更新しない。
 *
 * **1人の失敗で全体を止めない。** 10人を順に見るので、1人の異常で
 * 残りが積まれないほうが困る。**失敗した数は返す**（0件成功を
 * 「対象がいなかった」と読み違えないため）。
 *
 * 積むのは**それぞれのモジュールの入口**で、冪等キーの作り方は
 * そちらが持つ（ここでは日付を組み立てない）。
 */
export async function runDailySchedule(
  params: { now?: Date | undefined } = {},
): Promise<DailyScheduleResult> {
  const now = params.now ?? new Date();

  const monitors = (await listMonitorsForAdmin()).filter(
    (monitor) => monitor.status === 'ACTIVE',
  );

  const result: DailyScheduleResult = {
    users: monitors.length,
    queued: {
      searchMetrics: 0,
      indexStatus: 0,
      dailyAggregate: 0,
      linkCheck: 0,
    },
    failed: 0,
  };

  for (const monitor of monitors) {
    try {
      // **検索データ → インデックス → 集計の順に積む。** ジョブの実行順は
      // 保証されないが、**集計は生イベントから数え直す**ので（G-6）、
      // 順が入れ替わっても翌日には正しくなる
      result.queued.searchMetrics += await enqueueSearchMetricsForUser(
        monitor.id,
        { now },
      );
      result.queued.indexStatus += await enqueueIndexStatusForUser(monitor.id, {
        now,
      });
      result.queued.dailyAggregate += await enqueueDailyAggregateForUser(
        monitor.id,
        { now },
      );

      if (await enqueueLinkCheckForUser(monitor.id, { now })) {
        result.queued.linkCheck += 1;
      }
    } catch (error) {
      // **利用者IDだけを残す。** 中身は出さない（SPEC 14.2）
      result.failed += 1;
      logger.error('日次ジョブを積めなかった', {
        userId: monitor.id,
        cause: error,
      });
    }
  }

  return result;
}
