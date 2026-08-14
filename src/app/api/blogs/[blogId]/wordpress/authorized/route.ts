import { getServerEnv } from '@/lib/env';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { requireConsentedUser } from '@/modules/auth';
import {
  connectWordpressForUser,
  matchesRequestedSite,
  verifyAuthorizeState,
} from '@/modules/wordpress';

/**
 * `GET /api/blogs/:blogId/wordpress/authorized`（SPEC 7.1 v2.3、TASKS I-8）
 *
 * WordPress の承認画面からの戻り先。
 *
 * ## 戻りにパスワードが載っている
 *
 * **WordPress の仕様。** `success_url` に `user_login` と `password` が
 * **クエリとして**付く。
 *
 * **保存したら、クエリを落としたURLへ即座に転送する。** そのままにすると、
 * ブラウザの履歴・`Referer`・アクセスログに残り続ける。
 *
 * **この値をログへ出さない**（SPEC 14.2）。失敗しても**受け取った値を
 * 添えない** — 「何が来たか」を残すと、そこに秘密が入る。
 *
 * ## 画面へ戻す。エラーでもJSONを返さない
 *
 * **ここはブラウザの遷移先である。** JSONを返すと、モニターは
 * 生のJSONを見ることになる。**結果は問い合わせ文字列で画面へ渡す。**
 *
 * ## 何を確かめるか
 *
 * | | 確かめること |
 * |---|---|
 * | 1 | セッション（**他人のブラウザで戻ってきていない**） |
 * | 2 | `state` の署名と期限 |
 * | 3 | `state` の利用者・ブログが、いまの経路と一致する |
 * | 4 | 戻りの `site_url` が、依頼したサイトと同じ |
 *
 * **3が要る。** 署名は「Bunshin が出した依頼」であることしか示さない。
 * 自分の別のブログ枠へ差し替えられるのを止めるのは、この照合である。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ blogId: string }> };

/** 画面へ戻す。**結果だけを載せ、受け取った値は載せない** */
function backToBlog(
  blogId: string,
  outcome: 'connected' | 'rejected' | 'failed',
): Response {
  return Response.redirect(
    new URL(
      `/liff/blogs/${blogId}/wordpress?authorize=${outcome}`,
      process.env['APP_BASE_URL'] ?? 'http://localhost:3000',
    ).toString(),
    302,
  );
}

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const { blogId } = await context.params;

  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));

    const query = new URL(request.url).searchParams;
    const state = query.get('state');

    // **拒否したときはパスワードが載らない。** 押し間違いなので、
    // 失敗ではなく「拒否」として画面へ戻す
    const password = query.get('password');
    if (state === null || password === null || password === '') {
      return backToBlog(blogId, 'rejected');
    }

    const verified = verifyAuthorizeState(state, {
      secret: getServerEnv().SESSION_SECRET,
    });

    // **署名・期限・利用者・ブログをまとめて見る。** どれで落ちたかを
    // 画面へ伝えない（外から状態を調べる手がかりになる）
    if (
      verified === null ||
      verified.userId !== user.id ||
      verified.blogId !== blogId ||
      !matchesRequestedSite(verified, query.get('site_url'))
    ) {
      // **受け取った値を添えない**（SPEC 14.2）
      logger.warn('WordPressの認可の戻りを受け付けなかった', { blogId });

      return backToBlog(blogId, 'failed');
    }

    const userLogin = query.get('user_login');
    if (userLogin === null || userLogin === '') {
      logger.warn('WordPressの認可の戻りに利用者名が無い', { blogId });

      return backToBlog(blogId, 'failed');
    }

    // **保存は手で貼ったときと同じ経路を通る**（`connectWordpressForUser`）。
    // 接続先の変更の拒否（Q-007）も監査ログ（H-12）もそこが持つ
    await connectWordpressForUser(
      { userId: user.id, blogId },
      {
        siteUrl: verified.siteUrl,
        wpUsername: userLogin,
        appPassword: password,
      },
    );

    return backToBlog(blogId, 'connected');
  } catch (error) {
    // **セッションが無い・切れているときだけは、画面へ戻さない。**
    // どのブログの話かを名乗る前に、まずログインしてもらう
    if (
      error instanceof AppError &&
      (error.status === 401 || error.status === 403)
    ) {
      return toErrorHttpResponse(error);
    }

    // **原因を画面へ出さない。** 接続先の変更の拒否も、
    // WordPress 側の不備も、ここでは同じ「失敗」
    logger.error('WordPressの認可の戻りを処理できなかった', {
      blogId,
      cause: error,
    });

    return backToBlog(blogId, 'failed');
  }
}
