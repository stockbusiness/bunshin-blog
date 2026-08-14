import { timingSafeEqual } from 'node:crypto';
import { toErrorHttpResponse } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { enqueuePublishPaceReview } from '@/modules/analytics';
import { drainJobs, runnerUnauthorizedError } from '@/modules/jobs';
import { JOB_HANDLERS } from './handlers';
import { enqueueDailySchedule, enqueueProposalNotify } from './schedule';

/**
 * `GET /api/jobs/run` — キューの消化（TASKS E-1、SPEC 4.3）
 *
 * **Cloud Scheduler から呼ばれる**（Q-045）。GET で叩き、
 * `Authorization: Bearer $CRON_SECRET` を**ヘッダとして設定してもらう**
 * （`docs/DEPLOY.md` 4.3）。
 *
 * **`CRON_SECRET` が未設定なら実行しない**（fail closed）。設定漏れで
 * 誰でもワーカーを起動できる状態にしない。`src/lib/env.ts` の必須には
 * 入れていない。cron の設定漏れでアプリ全体を止めないため（B-11 と同じ方針）。
 *
 * **締め切りを持って抜ける。** リクエストの上限を超えると途中で
 * 殺され、実行結果が記録されない。残ったジョブは次の起動で処理する。
 *
 * ## 決まった間隔のジョブをここで積む
 *
 * **cron はこの1つだけ。** 間隔ごとに cron を増やすより、
 * **間隔を冪等キーに持たせて**ここから積むほうが、設定が1か所で済む
 * （G-8b・I-1・I-2）。毎分呼ばれても、**同じ回のジョブは1件しか
 * 積まれない**（C-4）。
 *
 * | ジョブ | 間隔 | 冪等キー |
 * |---|---|---|
 * | `DAILY_SCHEDULE` | 1日1回 | JSTの暦日 |
 * | `PUBLISH_PACE_REVIEW` | 2週間に1回 | 基準時刻からの回 |
 * | `PROPOSAL_NOTIFY` | 1時間に1回 | JSTの暦日＋時 |
 *
 * **積めなくても消化は続ける。** 積むのは次の分でもできる。
 */

export const runtime = 'nodejs';

/**
 * 消化を打ち切るまでの時間（ミリ秒）。
 *
 * **Cloud Run のリクエスト上限ではなく、cron の間隔に合わせてある**
 * （Q-045）。毎分呼ばれるので、**次の起動が来る前に抜ける。**
 *
 * 延ばすと消化が重なる。同じジョブを二重に取ることは無いが
 * （`SELECT ... FOR UPDATE SKIP LOCKED`）、**AI呼び出しが同時に
 * 何本も走る。** 費用と流量の判断が要るので、実際に記事生成を
 * 回してから決める（Q-045 の「残る課題」）。
 *
 * 延ばすときは `LEASE_SECONDS`（中断されたジョブを戻すまでの時間）が
 * これより十分に長いことと、**Cloud Run のリクエスト上限**
 * （`docs/DEPLOY.md` 4.2）がこれより長いことを確認する。
 */
const DRAIN_BUDGET_MS = 50_000;

/**
 * 秘密の照合。**長さの違いも含めて一定時間で比べる。**
 * 文字列比較は先頭から一致した分だけ時間が変わり、値を推測できる。
 */
function matchesSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    // 長さが違っても同じだけ時間を使う
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
}

function authorize(request: Request): void {
  const expected = process.env['CRON_SECRET'];
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  // 未設定と不一致を区別しない。区別すると設定状態を外から調べられる
  if (expected === undefined || expected === '' || provided === '') {
    throw runnerUnauthorizedError();
  }

  if (!matchesSecret(provided, expected)) {
    throw runnerUnauthorizedError();
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    authorize(request);

    // **消化の前に積む。** 積んだ分をこの実行で拾えるようにする
    try {
      if (await enqueueDailySchedule()) {
        logger.info('日次ジョブの積み込みを積んだ');
      }

      if (await enqueuePublishPaceReview()) {
        logger.info('公開ペースの見直しを積んだ');
      }

      if (await enqueueProposalNotify()) {
        logger.info('提案の送信を積んだ');
      }
    } catch (error) {
      // **積めなくても消化は続ける。** 次の分で積める
      logger.error('定期ジョブを積めなかった', { cause: error });
    }

    const result = await drainJobs({
      registry: JOB_HANDLERS,
      deadline: new Date(Date.now() + DRAIN_BUDGET_MS),
    });

    logger.info('ジョブの消化が終わった', { ...result });

    return Response.json({ result });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
