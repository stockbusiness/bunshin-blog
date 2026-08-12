import { jstHour, todayInJst } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import {
  enqueueDailyAggregateForUser,
  enqueueIndexStatusForUser,
  enqueueSearchMetricsForUser,
} from '@/modules/analytics';
import { enqueueProposalSelectionForUser } from '@/modules/approvals';
import { enqueueArticleGenerationForUser } from './article-schedule';
import {
  enqueueLinkCheckForUser,
  sendPendingProposalsForUser,
  type SendProposalsDeps,
} from '@/modules/line';
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
    proposalSelection: number;
    articleGeneration: number;
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
      proposalSelection: 0,
      articleGeneration: 0,
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

      // **提案の選定は1日1回**（I-2）。送るのは別のジョブで、
      // **送れる時間帯まで待つ**（F-3b）
      if (await enqueueProposalSelectionForUser(monitor.id, { now })) {
        result.queued.proposalSelection += 1;
      }

      // **記事生成はブログ単位**（公開する曜日がブログごとに違う。I-4）。
      // **1ブログの失敗で他のブログを止めない**ので、失敗の数はここへ足す
      const articles = await enqueueArticleGenerationForUser(monitor.id, {
        now,
      });

      result.queued.articleGeneration += articles.queued;
      result.failed += articles.failed;
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

/**
 * 提案の送信を積む（TASKS I-2）。
 *
 * **1時間に1回。** 日次にできない — 送ってよい時間帯はモニターごとに
 * 違い（F-3b、既定は指定時刻から3時間）、**日次の積み込みが走る深夜とは
 * 限らない。** 1日1回しか試さないと、**その人の朝が来る前に判定が終わり、
 * 提案は一度も届かない。**
 *
 * **利用者ごとに積まない。** 1時間おきに10人ぶんの行を作ると1日240件に
 * なり、そのほとんどは「時間帯の外」で何もせず終わる。**1件のジョブが
 * 全員を順に見る**（`DAILY_SCHEDULE` と同じ形）。
 *
 * 時間帯の判定そのものは `sendPendingProposalsForUser` が持つ。
 * **ここでは判定しない** — 2か所に置くと、どちらが効いているのか読めない。
 *
 * @returns 新しく積んだなら `true`
 */
export async function enqueueProposalNotify(
  params: { now?: Date | undefined } = {},
): Promise<boolean> {
  const now = params.now ?? new Date();

  const result = await enqueueJob({
    jobType: 'PROPOSAL_NOTIFY',
    // **日付と時をJSTで組にする**（`jstHour` の理由もそこにある）
    idempotencyKey: `PROPOSAL_NOTIFY:${todayInJst(now)}:${jstHour(now)}`,
    input: {},
  });

  return result.created;
}

export interface ProposalNotifyResult {
  /** 対象になった利用者の数 */
  users: number;
  /** 実際に送れた提案の件数 */
  sent: number;
  /** 時間帯の外だった利用者の数 */
  outOfWindow: number;
  /** 期限切れにした未送信の提案の件数（F-3b） */
  expired: number;
  /** 送信に失敗した利用者の数。**0でないことが分かるように返す** */
  failed: number;
}

/**
 * 溜まっている提案を送る（`PROPOSAL_NOTIFY` の中身）。
 *
 * **`ACTIVE` の利用者だけ。** 停止した利用者に提案が届くと、
 * 止めたはずのものが動いて見える（F-2）。
 *
 * **1人の失敗で全体を止めない。** 二重送信は `sent_at` を先に立てる
 * 仕組みが押さえるので（F-2）、ジョブごと再試行されても安全。
 */
export async function runProposalNotify(
  deps: SendProposalsDeps = {},
): Promise<ProposalNotifyResult> {
  const now = deps.now ?? new Date();

  const monitors = (await listMonitorsForAdmin()).filter(
    (monitor) => monitor.status === 'ACTIVE',
  );

  const result: ProposalNotifyResult = {
    users: monitors.length,
    sent: 0,
    outOfWindow: 0,
    expired: 0,
    failed: 0,
  };

  for (const monitor of monitors) {
    try {
      // **件数の上限を渡さない。** 1日に何件送るかは F-3 が持つ。
      // ここで渡すと、上限が2か所に分かれる
      const sent = await sendPendingProposalsForUser(
        monitor.id,
        {},
        { ...deps, now },
      );

      result.sent += sent.sent.length;
      result.expired += sent.expired;

      if (!sent.inWindow) {
        result.outOfWindow += 1;
      }
    } catch (error) {
      // **利用者IDだけを残す。** 中身は出さない（SPEC 14.2）
      result.failed += 1;
      logger.error('提案を送れなかった', {
        userId: monitor.id,
        cause: error,
      });
    }
  }

  return result;
}
