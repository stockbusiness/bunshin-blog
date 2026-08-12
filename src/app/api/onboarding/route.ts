import { toErrorHttpResponse } from '@/lib/errors';
import { listOffersForUser } from '@/modules/affiliate';
import { requireUser } from '@/modules/auth';
import { listBlogsForUser } from '@/modules/blogs';
import { countActivePersonasForUser } from '@/modules/personas';
import {
  findNotificationScheduleForUser,
  resolveOnboardingProgress,
  type OnboardingFacts,
} from '@/modules/users';
import { findWordpressConnectionForUser } from '@/modules/wordpress';

/**
 * `GET /api/onboarding` オンボーディングの現在地（TASKS H-2a、SPEC 6.1）。
 *
 * ## 現在地を保存しない
 *
 * **毎回データから導く。** 段の番号を列に持つと、別の画面で作業したときに
 * 食い違う（分身の画面で分身を作っても番号は進まない）。
 *
 * ## 集めるのはここ（上位へ寄せる）
 *
 * 判定に要る事実は `users` `personas` `blogs` `wordpress` `affiliate` に
 * またがる。**`users` からこれらを import すると循環する**
 * （多くのモジュールが `users` に依存している）。MODULE_RULES 3 の
 * 「上位へ寄せる」で、集めるのを `src/app/` に置く。
 *
 * ## 同意の前でも見られる
 *
 * `requireConsentedUser` ではなく `requireUser` を使う。
 * **同意そのものが段2・3**で、同意していないと現在地すら見られないのでは
 * 詰む。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request.headers.get('cookie'));

    const [blogs, activePersonas, schedule] = await Promise.all([
      listBlogsForUser(user.id),
      countActivePersonasForUser(user.id),
      findNotificationScheduleForUser(user.id),
    ]);

    // **ブログが1件でも条件を満たせば済み。** 3件すべてを求めると、
    // 1ブログで始める人（段階解放の初日は1体）が永久に終わらない
    const connections = await Promise.all(
      blogs.map((blog) =>
        findWordpressConnectionForUser({
          userId: user.id,
          blogId: blog.id,
        }),
      ),
    );

    const offers = await Promise.all(
      blogs.map((blog) =>
        listOffersForUser({ userId: user.id, blogId: blog.id }),
      ),
    );

    const facts: OnboardingFacts = {
      // ここへ来られている時点で真
      lineLogin: true,
      termsAccepted: user.termsAcceptedAt !== null,
      dataConsented: user.dataUseConsentAt !== null,
      hasActivePersona: activePersonas > 0,
      hasBlog: blogs.length > 0,
      // **繋いだだけでは済みにしない**（C-2 の接続テストまで）
      hasConnectedWordpress: connections.some(
        (connection) => connection?.connectionStatus === 'CONNECTED',
      ),
      hasGenre: blogs.some((blog) => blog.genre !== null),
      hasOffer: offers.some((list) => list.length > 0),
      hasNotificationSetting: schedule !== null,
      // トークンを発行していれば、スニペットを入れる段まで来ている（D-12）
      hasLinkEventToken: blogs.some(
        (blog) => blog.linkEventTokenIssuedAt !== null,
      ),
    };

    return Response.json({ progress: resolveOnboardingProgress(facts) });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
