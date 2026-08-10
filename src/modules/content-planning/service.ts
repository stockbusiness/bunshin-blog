/**
 * ジャンル審査の入口（TASKS E-4、SPEC 9.2.2）。
 *
 * ## 判定 → 記録 → 説明の順で行う
 *
 * **AIを呼べなくても判定と記録は残る。** 説明文は利用者への伝え方であって、
 * 可否そのものではない。ここを逆にすると、AIが落ちている間ジャンル審査が
 * 止まる（そして「止まったから通す」が始まる）。
 *
 * ## 続行は差し戻し2回のあとだけ
 *
 * > 差し戻しは2回まで。3回目は「リスクを理解して進める」を選択可能とし、
 * > その選択を記録する（SPEC 9.2.2）
 *
 * 早く通すと停止条件が実質的に無くなるため、**回数はDBの履歴から数える。**
 * 呼び出し側が申告した回数を信じない。
 */

import { logger } from '@/lib/logger';
import { findGenre, requireBlogForUser } from '@/modules/blogs';
import { recordAudit } from '@/modules/audit';
import { listOffersForUser } from '@/modules/affiliate';
import { listPersonaFactsForUser } from '@/modules/personas';
import { createConfiguredAiProvider } from '@/modules/settings';
import type { AiProvider } from '@/lib/ai';
import { describeGenreReview, suggestAlternativeGenres } from './ai';
import { genreNotFoundError, overrideNotAllowedError } from './errors';
import {
  countRejectionsForUser,
  listPlanningRunsForUser,
  recordStep1Run,
} from './repository';
import {
  MAX_REJECTIONS,
  filterAlternatives,
  judgeGenre,
  offersOverride,
} from './step1';
import type { SerpEntry } from './step1';
import type { GenreReviewResult } from './types';

export interface ReviewGenreInput {
  userId: string;
  blogId: string;
  genreId: string;
  /**
   * 検索上位の内訳。取得できなければ ADMIN の手動入力（SPEC 9.2.2）。
   * **空では審査できない**（判定を飛ばさない）
   */
  serpTop10: readonly SerpEntry[];
  userHasExperience: boolean;
}

export interface ReviewGenreDeps {
  /** 差し替え用。既定は設定から組み立てる（H-10） */
  provider?: AiProvider | undefined;
  /** AIを呼ばない。判定と記録だけを行う */
  skipAi?: boolean | undefined;
}

/**
 * 案件数を数える。
 *
 * **`ENDED` を除く。** 終了した案件を数えると、実際には貼れない案件で
 * 「案件が0件」の停止条件を回避できてしまう。
 */
async function countUsableOffers(params: {
  userId: string;
  blogId: string;
}): Promise<number> {
  const offers = await listOffersForUser(params);

  return offers.filter((offer) => offer.status !== 'ENDED').length;
}

async function resolveProvider(
  deps: ReviewGenreDeps,
): Promise<AiProvider | null> {
  if (deps.skipAi === true) {
    return null;
  }

  return deps.provider ?? (await createConfiguredAiProvider());
}

/**
 * ジャンルを審査する（完了条件「停止条件を満たすジャンルが通過しない」）。
 *
 * @throws {AppError} ブログが自分のものでない・ジャンルが無い・入力が不正
 */
export async function reviewGenreForUser(
  input: ReviewGenreInput,
  deps: ReviewGenreDeps = {},
): Promise<GenreReviewResult> {
  await requireBlogForUser(input);

  const genre = await findGenre(input.genreId);
  if (genre === null) {
    throw genreNotFoundError();
  }

  const offerCount = await countUsableOffers(input);

  // **判定が先。** AIが落ちていても可否は決まる
  const judgement = judgeGenre({
    genreName: genre.name,
    ymylRisk: genre.ymylRisk,
    offerCount,
    serpTop10: input.serpTop10,
    userHasExperience: input.userHasExperience,
  });

  const rejectionCount = await countRejectionsForUser(input);

  const run = await recordStep1Run({
    userId: input.userId,
    blogId: input.blogId,
    decision: judgement.decision,
    reasons: judgement.reasons,
    rejectionCount,
    overridden: false,
  });

  const canOverride = offersOverride({
    decision: judgement.decision,
    // 今回の分を含めて数える。今回で2回目の差し戻しなら、次に選べる
    rejectionCount: rejectionCount + (judgement.decision === 'BLOCKED' ? 1 : 0),
  });

  const provider = await resolveProvider(deps);

  if (provider === null) {
    return { run, judgement, text: null, alternatives: [], canOverride };
  }

  return {
    run,
    judgement,
    canOverride,
    text: await describeSafely(provider, genre.name, judgement),
    alternatives:
      judgement.decision === 'BLOCKED'
        ? await suggestSafely(provider, input, genre.name, judgement.blockedBy)
        : [],
  };
}

/**
 * 説明文を作る。**失敗しても審査を落とさない。**
 *
 * 判定と記録は既に済んでいる。ここで投げると、通ったはずの審査が
 * AIの不調で失敗したように見える。
 */
async function describeSafely(
  provider: AiProvider,
  genreName: string,
  judgement: { decision: 'PASSED' | 'WARNED' | 'BLOCKED'; reasons: string[] },
): Promise<GenreReviewResult['text']> {
  try {
    return await describeGenreReview({
      provider,
      genreName,
      decision: judgement.decision,
      reasons: judgement.reasons,
      userHasExperience: true,
    });
  } catch (error) {
    logger.warn('ジャンル審査の説明文を作れなかった', {
      decision: judgement.decision,
      cause: error,
    });

    return null;
  }
}

/** 候補を出す。**失敗しても審査を落とさない**（同上） */
async function suggestSafely(
  provider: AiProvider,
  input: ReviewGenreInput,
  genreName: string,
  blockedBy: readonly string[],
): Promise<GenreReviewResult['alternatives']> {
  try {
    const facts = await listPersonaFactsForUser(input.userId, {
      blogId: input.blogId,
    });
    const candidates = await suggestAlternativeGenres({
      provider,
      genreName,
      blockedReasons: blockedBy,
      experiences: facts.map((fact) => fact.content),
    });

    // **除外はコードで行う**（CONTENT_PLANNING 2.3）
    return filterAlternatives(candidates, [genreName]);
  } catch (error) {
    logger.warn('別ジャンルの候補を作れなかった', { cause: error });

    return [];
  }
}

/**
 * 停止条件を承知で進める（SPEC 9.2.2）。
 *
 * **差し戻し2回より前は通さない。** 通すと停止条件が実質的に無くなる。
 *
 * 選択は `planning_runs.overridden_at` に残す。**`audit_logs` にも残すよう
 * SPEC 9.2.2 が定めているが、`audit` モジュールが未実装**のため、そちらは
 * H-11 で足す（他モジュールのテーブルを直接書けない。MODULE_RULES 1）。
 *
 * @throws {AppError} まだ選べる回数に達していない
 */
export async function overrideGenreBlockForUser(input: {
  userId: string;
  blogId: string;
  genreId: string;
  serpTop10: readonly SerpEntry[];
  userHasExperience: boolean;
}): Promise<GenreReviewResult> {
  await requireBlogForUser(input);

  const genre = await findGenre(input.genreId);
  if (genre === null) {
    throw genreNotFoundError();
  }

  const rejectionCount = await countRejectionsForUser(input);

  if (rejectionCount < MAX_REJECTIONS) {
    throw overrideNotAllowedError(MAX_REJECTIONS - rejectionCount);
  }

  const offerCount = await countUsableOffers(input);
  const judgement = judgeGenre({
    genreName: genre.name,
    ymylRisk: genre.ymylRisk,
    offerCount,
    serpTop10: input.serpTop10,
    userHasExperience: input.userHasExperience,
  });

  const run = await recordStep1Run({
    userId: input.userId,
    blogId: input.blogId,
    // **判定は書き換えない。** 「止まったが承知で進めた」と分かる値を入れる
    decision: 'OVERRIDDEN',
    reasons: judgement.reasons,
    rejectionCount,
    overridden: true,
  });

  // **「普通ではないこと」を横断で辿れるようにする**（SPEC 9.2.2、H-11）。
  // 選択そのものは `planning_runs.overridden_at` にも残っているが、
  // そちらはブログ単位でしか引けない
  await recordAudit({
    actorUserId: input.userId,
    action: 'GENRE_BLOCK_OVERRIDDEN',
    entityType: 'planning_run',
    entityId: run.id,
    // **秘密を入れない**（SPEC 14.2）。何を承知したかだけを残す
    metadata: {
      blogId: input.blogId,
      genreId: input.genreId,
      genreName: genre.name,
      rejectionCount,
      reasons: judgement.reasons,
    },
  });

  return {
    run,
    judgement,
    text: null,
    alternatives: [],
    canOverride: false,
  };
}

export { listPlanningRunsForUser };
