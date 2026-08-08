/**
 * ジョブの冪等性キー（TASKS C-4、SPEC 7.3）。
 *
 * SPEC 7.3 は「`content_item_id` ごとの冪等性キー」とだけ定める。
 * **キーの作り方を1か所に固定する**のがこのファイルの役目で、
 * 呼び出し側がその場で文字列を組み立てると次の2つが起きる。
 *
 * - **種類をまたいだ衝突。** 同じ `content_item_id` に対する
 *   `WORDPRESS_POST` と `WORDPRESS_SYNC` が同じキーになると、後から
 *   積んだほうが**黙って既存のジョブとして扱われ、実行されない**
 * - **表記ゆれ。** 積む側と探す側で組み立て方が違うと、同じ処理が
 *   二重に積まれる
 *
 * どちらも「積んだのに動かない」「二重に動く」という形で表に出るため、
 * **キーは必ず `<種類>:<対象>` で始める**という規則を検証で強制する。
 *
 * ### 種類ごとに何を対象にするか
 *
 * | 種類 | 対象 | 補足 |
 * |---|---|---|
 * | `WORDPRESS_POST` | `content_item_id` | SPEC 7.3 |
 * | `WORDPRESS_SYNC` | `content_item_id` | |
 * | `ARTICLE_GENERATION` | `content_item_id` | |
 * | `ARTICLE_REGENERATION` | `content_item_id` + 修正依頼ID | 依頼ごとに1回 |
 * | `BLOG_ANALYSIS` | `blog_id` | |
 * | `PLAN_GENERATION` | `content_plan_id` | |
 * | `SEARCH_CONSOLE_FETCH` | `blog_id` + 対象日 | 日ごとに1回 |
 * | `GA4_FETCH` | `blog_id` + 対象日 | 同上 |
 * | `PROPOSAL_SELECTION` | `blog_id` + 対象日 | 同上 |
 * | `LINE_NOTIFY` | 通知の対象ID | |
 * | `LINK_CHECK` | `blog_id` + 対象日 | 同上 |
 *
 * この表は規則であって強制ではない（対象IDの意味はジョブごとに違う）。
 * 強制できるのは**種類が前置されていること**までで、そこは検証する。
 */

import { AppError } from '@/lib/errors';
import { JOB_ERROR_CODES, unknownJobTypeError } from './errors';
import { isJobType, type JobType } from './types';

/** 種類と対象を区切る文字。**対象の側には現れてはいけない** */
export const IDEMPOTENCY_KEY_SEPARATOR = ':';

/**
 * キーの長さの上限。
 *
 * DBの列は `text` で上限が無いが、索引（unique）に載る値であり、
 * 際限なく伸びる値を入れさせない。UUIDを3つ繋いでも収まる。
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** 対象に使える文字。空白・制御文字・区切り文字を除く */
const PART_PATTERN = /^[A-Za-z0-9._-]+$/;

function invalidKeyError(reason: string): AppError {
  return new AppError(
    JOB_ERROR_CODES.invalidIdempotencyKey,
    422,
    `冪等性キーが不正です: ${reason}`,
  );
}

/**
 * 冪等性キーを組み立てる。
 *
 * `buildIdempotencyKey('WORDPRESS_POST', contentItemId)` は
 * `WORDPRESS_POST:<contentItemId>` になる。
 *
 * **同じ入力からは必ず同じキーができる。** 時刻や乱数を混ぜない。
 * 混ぜると再実行のたびに別のジョブが積まれ、冪等性が壊れる。
 *
 * @throws {AppError} 知らない種類・対象が空・使えない文字・長すぎる
 */
export function buildIdempotencyKey(
  jobType: JobType,
  ...parts: readonly string[]
): string {
  if (!isJobType(jobType)) {
    throw unknownJobTypeError(jobType);
  }

  if (parts.length === 0) {
    throw invalidKeyError('対象が指定されていません');
  }

  for (const part of parts) {
    if (part === '') {
      throw invalidKeyError('対象が空です');
    }

    if (!PART_PATTERN.test(part)) {
      // 区切り文字を含む値を許すと `A:B` + `C` と `A` + `B:C` が
      // 同じキーになる（衝突する）
      throw invalidKeyError(`対象に使えない文字が含まれます: ${part}`);
    }
  }

  const key = [jobType, ...parts].join(IDEMPOTENCY_KEY_SEPARATOR);

  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw invalidKeyError(
      `${IDEMPOTENCY_KEY_MAX_LENGTH}文字以内にしてください（${key.length}文字）`,
    );
  }

  return key;
}

/** キーが種類と対応しているか */
export function matchesJobType(key: string, jobType: JobType): boolean {
  return key.startsWith(`${jobType}${IDEMPOTENCY_KEY_SEPARATOR}`);
}

/**
 * 投入時にキーを検証する。
 *
 * **積む前に落とす。** 不正なキーのまま積むと、行は残るのに再投入で
 * 引き当てられず、同じ処理が別のキーで二重に積まれる。
 *
 * @throws {AppError} 種類と対応していない・長すぎる
 */
export function assertIdempotencyKey(jobType: JobType, key: string): void {
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw invalidKeyError(
      `${IDEMPOTENCY_KEY_MAX_LENGTH}文字以内にしてください（${key.length}文字）`,
    );
  }

  if (!matchesJobType(key, jobType)) {
    throw invalidKeyError(`${jobType} で始まっていません`);
  }

  const target = key.slice(jobType.length + 1);
  if (target === '') {
    throw invalidKeyError('対象が空です');
  }
}
