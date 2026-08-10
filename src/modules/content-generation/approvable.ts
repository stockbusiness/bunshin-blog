/**
 * 承認へ送れる記事を引く入口（TASKS F-1）。
 *
 * **ブログIDを呼び出し側から受け取らない。** `userId` から自分のブログを
 * 引き直す。IDを渡せる形にすると、`approvals` の絞り込みが漏れたときに
 * 他人のブログの記事が提案される（C-6 と同じ形の穴）。
 */

import { listBlogsForUser } from '@/modules/blogs';
import {
  listApprovableArticles,
  type ApprovableArticle,
} from './article-repository';

/**
 * 自分の全ブログから、承認へ送れる記事を引く（3ブログ横断。SPEC 9.1）。
 *
 * `CLOSED` のブログは外れる（`listBlogsForUser` の既定）。
 */
export async function listApprovableArticlesForUser(
  userId: string,
): Promise<ApprovableArticle[]> {
  const blogs = await listBlogsForUser(userId);

  return listApprovableArticles(blogs.map((blog) => blog.id));
}
