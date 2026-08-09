/**
 * STEP 2 案件スコアリングの入口（TASKS E-5、SPEC 9.2.3）。
 *
 * ## AIに聞くのは検索需要の3値だけ
 *
 * 足切りもスコアも `step2.ts` が出す。AIの応答が無くても採点は成立し、
 * **検索需要が0点になるだけ**（15点分）。呼べないことを理由に
 * 採点そのものを止めない。
 *
 * ## 未評価の案件は採点対象外
 *
 * D-2 のLP自動評価が済んでいない案件は足切りする（`lp_not_evaluated`）。
 * **「点が足りなかった」と分けて数え**、ADMINへ知らせる材料にする
 * （CONTENT_PLANNING 3.1）。
 *
 * ## 0件なら STEP 1 へ差し戻す
 *
 * SPEC 9.2.3。ここでは「差し戻すべきか」を返すところまでを担い、
 * 実際に STEP 1 を呼び直すのは呼び出し側（E-9 のジョブ）。
 */

import { logger } from '@/lib/logger';
import type { AiProvider } from '@/lib/ai';
import { requireBlogForUser } from '@/modules/blogs';
import {
  listOffersForUser,
  saveOfferScoresForUser,
  type OfferScoreInput,
} from '@/modules/affiliate';
import { createConfiguredAiProvider } from '@/modules/settings';
import { askSearchDemand } from './ai';
import {
  adoptOffers,
  scoreOffer,
  unevaluatedOffers,
  type ScorableOffer,
  type ScoredOffer,
  type SearchDemand,
} from './step2';

export interface ScoreOffersInput {
  userId: string;
  blogId: string;
  /** 検索需要の判定に渡す。ジャンル名は `blogs` から来る */
  genreName: string;
}

export interface ScoreOffersDeps {
  provider?: AiProvider | undefined;
  /** AIを呼ばない。検索需要は `NONE`（0点）として採点する */
  skipAi?: boolean | undefined;
}

export interface ScoreOffersResult {
  /** 全案件の採点（足切りされたものも含む） */
  scored: ScoredOffer[];
  /** 採用した案件（60点以上の上位3件） */
  adopted: ScoredOffer[];
  /** LPが未評価のまま残っている案件。ADMINへ知らせる */
  unevaluated: ScoredOffer[];
  /** 採用0件。STEP 1 へ差し戻す（SPEC 9.2.3） */
  needsGenreReview: boolean;
}

/**
 * 検索需要を聞く。**失敗しても採点を止めない。**
 *
 * 落ちたときは `NONE`（0点）。**「需要が無い」ではなく「聞けなかった」**
 * だが、点を勝手に足すよりは低く出るほうが安全（採用されるべきでない
 * 案件を通すより、通るべき案件が落ちるほうが取り返しがつく）。
 */
async function askDemandSafely(
  provider: AiProvider | null,
  offer: ScorableOffer,
  genreName: string,
): Promise<SearchDemand> {
  if (provider === null) {
    return 'NONE';
  }

  try {
    return await askSearchDemand({
      provider,
      offerName: offer.name,
      advertiserName: offer.advertiserName,
      genreName,
    });
  } catch (error) {
    logger.warn('検索需要を判定できなかった', {
      offerId: offer.id,
      cause: error,
    });

    return 'NONE';
  }
}

/**
 * ブログの案件を採点し、採用を決める（完了条件）。
 *
 * 結果は `affiliate_offers.selection_score` と `score_breakdown` に保存する。
 *
 * @throws {AppError} ブログが自分のものでない
 */
export async function scoreOffersForUser(
  input: ScoreOffersInput,
  deps: ScoreOffersDeps = {},
): Promise<ScoreOffersResult> {
  await requireBlogForUser(input);

  const offers = await listOffersForUser({
    userId: input.userId,
    blogId: input.blogId,
  });

  const provider =
    deps.skipAi === true
      ? null
      : (deps.provider ?? (await createConfiguredAiProvider()));

  const scored: ScoredOffer[] = [];

  for (const offer of offers) {
    const scorable: ScorableOffer = {
      id: offer.id,
      name: offer.name,
      advertiserName: offer.advertiserName,
      conversionType: offer.conversionType,
      rewardYen: offer.rewardYen,
      denyConditions: offer.denyConditions,
      userExperience: offer.userExperience,
      lpFormFields: offer.lpFormFields,
      lpMobileReady: offer.lpMobileReady,
      lpEvaluatedAt: offer.lpEvaluatedAt,
      blogPostingProhibited: offer.blogPostingProhibited,
      status: offer.status,
    };

    // **足切りされる案件にAIを聞かない。** 点数に関わらず採用しないため、
    // 呼ぶだけ費用が増える
    const demand =
      scoreOffer(scorable, 'NONE').eligible === true
        ? await askDemandSafely(provider, scorable, input.genreName)
        : 'NONE';

    scored.push(scoreOffer(scorable, demand));
  }

  const payload: OfferScoreInput[] = scored.map((entry) => ({
    offerId: entry.offerId,
    score: entry.breakdown.total,
    breakdown: { ...entry.breakdown },
  }));

  // **足切りされた案件も保存する。** 落ちた理由を後から確かめられないと、
  // 「なぜ採用されなかったのか」に答えられない
  await saveOfferScoresForUser(
    { userId: input.userId, blogId: input.blogId },
    payload,
  );

  const adopted = adoptOffers(scored);

  return {
    scored,
    adopted,
    unevaluated: unevaluatedOffers(scored),
    needsGenreReview: adopted.length === 0,
  };
}
