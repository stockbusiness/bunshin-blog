/**
 * 提案を作る（TASKS F-1、SPEC 9.1「3ブログ横断で優先順位を付ける」）。
 *
 * 完了条件は「**優先度と提案理由が保存される**」。
 *
 * ## 送る記事を選ぶのはここではない
 *
 * ここは**候補すべてに点を付けて保存する**。1日に何件送るかは F-3、
 * 実際に送るのは F-2。**「作る」と「送る」を分ける**のは、
 * 送信に失敗した提案が消えないようにするため。
 */

import { todayInJst } from '@/lib/datetime';
import { listBlogsForUser } from '@/modules/blogs';
import { listApprovableArticlesForUser } from '@/modules/content-generation';
import { markItemsReadyForReview } from '@/modules/content-planning';
import { enqueueJob } from '@/modules/jobs';
import { rankProposals, type BlogProposalState } from './priority';
import {
  createApproval,
  listBlogApprovalHistoryForUser,
  type AppApproval,
} from './repository';

export interface RefreshProposalsDeps {
  /** 試験のために差し替える。既定は現在時刻 */
  now?: Date | undefined;
}

export interface RefreshProposalsResult {
  created: AppApproval[];
  /** 候補だったが既に提案済みだった件数 */
  skipped: number;
}

/**
 * 承認へ送れる記事から提案を作る。
 *
 * **ブログIDを引数に取らない。** 3ブログ横断で順位を付けるため、
 * 入口は利用者単位（SPEC 9.1）。
 */
export async function refreshProposalsForUser(
  userId: string,
  deps: RefreshProposalsDeps = {},
): Promise<RefreshProposalsResult> {
  const now = deps.now ?? new Date();

  const [blogs, candidates] = await Promise.all([
    listBlogsForUser(userId),
    listApprovableArticlesForUser(userId),
  ]);

  if (candidates.length === 0) {
    return { created: [], skipped: 0 };
  }

  const history = await listBlogApprovalHistoryForUser(
    userId,
    blogs.map((blog) => blog.id),
  );
  const historyByBlog = new Map(history.map((row) => [row.blogId, row]));

  const states: BlogProposalState[] = blogs.map((blog) => ({
    blogId: blog.id,
    blogName: blog.name,
    lastProposedAt: historyByBlog.get(blog.id)?.lastProposedAt ?? null,
    openProposalCount: historyByBlog.get(blog.id)?.openProposalCount ?? 0,
  }));

  const ranked = rankProposals({ candidates, blogs: states, now });

  const created: AppApproval[] = [];
  let skipped = 0;

  for (const proposal of ranked) {
    const approval = await createApproval({
      userId,
      blogId: proposal.candidate.blogId,
      contentItemId: proposal.candidate.contentItemId,
      articleVersionId: proposal.candidate.articleVersionId,
      // Phase 0 で作るのは新規記事の提案だけ。改善提案は G 以降
      proposalType: 'NEW_ARTICLE',
      priorityScore: proposal.priorityScore,
      proposalReason: proposal.proposalReason,
    });

    if (approval === null) {
      skipped += 1;

      continue;
    }

    created.push(approval);
  }

  // **記事の状態を進めるのは提案ができてから。** 先に進めると、
  // 提案の作成に失敗した記事が「承認待ち」に見える
  await markItemsReadyForReview(
    created.map((approval) => approval.contentItemId),
  );

  return { created, skipped };
}

/**
 * 提案の選定を積む（TASKS I-2、SPEC 4.3）。
 *
 * **1日1回。** 冪等キーにJSTの暦日を入れるので、cron が何度呼んでも
 * その日は1件しか積まれない（C-4）。
 *
 * **ブログ単位で積まない。** 3ブログ横断で順位を付ける（SPEC 9.1）ので、
 * ブログごとに積むと**それぞれのブログの中でしか比べられなくなる。**
 *
 * @returns 新しく積んだなら `true`
 */
export async function enqueueProposalSelectionForUser(
  userId: string,
  deps: RefreshProposalsDeps = {},
): Promise<boolean> {
  const date = todayInJst(deps.now ?? new Date());

  const result = await enqueueJob({
    jobType: 'PROPOSAL_SELECTION',
    idempotencyKey: `PROPOSAL_SELECTION:${userId}:${date}`,
    input: {},
    userId,
  });

  return result.created;
}
