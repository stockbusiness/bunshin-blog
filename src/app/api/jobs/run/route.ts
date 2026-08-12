import { timingSafeEqual } from 'node:crypto';
import { toErrorHttpResponse } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { drainJobs, runnerUnauthorizedError } from '@/modules/jobs';
import { JOB_HANDLERS } from './handlers';
import { enqueueDailySchedule } from './schedule';

/**
 * `GET /api/jobs/run` — キューの消化（TASKS E-1、SPEC 4.3）
 *
 * **Vercel Cron から呼ばれる。** Vercel Cron は GET で叩き、
 * `Authorization: Bearer $CRON_SECRET` を付ける。定義は `vercel.json`。
 *
 * **`CRON_SECRET` が未設定なら実行しない**（fail closed）。設定漏れで
 * 誰でもワーカーを起動できる状態にしない。`src/lib/env.ts` の必須には
 * 入れていない。cron の設定漏れでアプリ全体を止めないため（B-11 と同じ方針）。
 *
 * **締め切りを持って抜ける。** 関数の実行時間の上限を超えると途中で
 * 殺され、実行結果が記録されない。残ったジョブは次の起動で処理する。
 *
 * ## 決まった間隔のジョブをここで積む
 *
 * **cron はこの1つだけ**（`vercel.json`）。間隔ごとに cron を増やすより、
 * **間隔を冪等キーに持たせて**ここから積むほうが、設定が1か所で済む
 * （I-1）。毎分呼ばれても、同じ日のものは1件しか積まれない（C-4）。
 *
 * **積めなくても消化は続ける。** 積むのは次の分でもできる。
 */

export const runtime = 'nodejs';

/**
 * 関数の最大実行時間（秒）。
 *
 * **Vercel のプランで上限が変わる。** ここを延ばす場合は、
 * `LEASE_SECONDS`（中断されたジョブを戻すまでの時間）がこれより
 * 十分に長いことを確認すること。
 */
export const maxDuration = 60;

/** 実際に抜ける時刻。関数の上限より手前に取る */
const DRAIN_BUDGET_MS = (maxDuration - 10) * 1000;

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
