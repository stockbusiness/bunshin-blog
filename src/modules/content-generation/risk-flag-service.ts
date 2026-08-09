/**
 * リスクフラグの付与（TASKS E-13、SPEC 9.6）。
 *
 * **事実チェック（E-12）と同じく、生成の中から必ず呼ぶ。**
 * 別の入口として置くと「呼び忘れた記事」が空のフラグのまま残り、
 * 承認画面で「指摘なし」に見える。
 *
 * 修正依頼（F-6）で人が本文を書き換えたあとも、承認へ進む前に
 * ここを通す想定で、単独でも呼べるようにしてある。
 */

import { requireBlogForUser } from '@/modules/blogs';
import { resolveEffectivePersonaForUser } from '@/modules/personas';
import {
  findLatestArticleVersion,
  requirePlannedItemForUser,
  saveRiskFlags,
  type AppArticleVersion,
} from './article-repository';
import { detectRiskFlags, type RiskFlag } from './risk-flags';
import { extractHrefs } from './article';
import { itemNotInPlanError } from './errors';

export interface ScanRiskFlagsInput {
  userId: string;
  blogId: string;
  contentItemId: string;
  /** 省略したら最新の版を見る */
  articleVersionId?: string | undefined;
}

export interface ScanRiskFlagsResult {
  version: AppArticleVersion;
  flags: RiskFlag[];
}

/**
 * 記事のリスクフラグを付け直して保存する。
 *
 * @throws {AppError} 自分の記事でない・版が無い
 */
export async function scanRiskFlagsForUser(
  input: ScanRiskFlagsInput,
): Promise<ScanRiskFlagsResult> {
  await requireBlogForUser(input);

  const item = await requirePlannedItemForUser(input);
  const latest = await findLatestArticleVersion(item.id);

  if (latest === null) {
    throw itemNotInPlanError();
  }

  if (
    input.articleVersionId !== undefined &&
    input.articleVersionId !== latest.id
  ) {
    throw itemNotInPlanError();
  }

  const persona = await resolveEffectivePersonaForUser({
    userId: input.userId,
    blogId: input.blogId,
  });

  // **本文から実際に判断する。** 「案件が紐づいているか」ではなく
  // 「本文に外部リンクがあるか」— PR表記が要るのは広告リンクの有無で
  // 決まる（E-10 と同じ考え。SPEC 15.2）
  const hasAffiliateLink = extractHrefs(latest.bodyHtml).some(
    (href) => !href.startsWith('#'),
  );

  const flags = detectRiskFlags({
    bodyHtml: latest.bodyHtml,
    hasAffiliateLink,
    ngExpressions: persona.ngExpressions,
  });

  const version = await saveRiskFlags({
    contentItemId: item.id,
    articleVersionId: latest.id,
    riskFlags: flags,
  });

  return { version, flags };
}
