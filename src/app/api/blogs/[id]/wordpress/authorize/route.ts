import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { getServerEnv } from '@/lib/env';
import { requireConsentedUser } from '@/modules/auth';
import { requireBlogForUser } from '@/modules/blogs';
import { buildAuthorizeUrl, createAuthorizeState } from '@/modules/wordpress';

/**
 * `POST /api/blogs/:id/wordpress/authorize`（SPEC 7.1 v2.3、TASKS I-8）
 *
 * WordPress の承認画面へ送るURLを組み立てて返す。
 *
 * **転送しない。** LIFF は画面遷移を自分で持つので、URLを返して
 * 開くのは画面に任せる。**サーバーから 302 で飛ばすと、戻ってきたときに
 * どの画面へ帰ればよいかを画面側が覚えていられない。**
 *
 * **アプリケーションパスワードはここでは扱わない。** 発行するのは
 * モニターの WordPress で、Bunshin は受け取るだけ（`authorized`）。
 */

export const runtime = 'nodejs';

const authorizeSchema = z.object({
  // **サイトURLは毎回受け取る。** 未接続のブログにはまだ保存が無く、
  // 再接続では保存済みと同じであることを `connectWordpressForUser` が見る
  siteUrl: z.string().min(1).max(255),
});

type Context = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;

    // **自分のブログであることを先に確かめる**（SPEC 14.1）。
    // 確かめずに `state` を発行すると、**署名付きの依頼そのものが
    // 他人のブログを指せる**
    const blog = await requireBlogForUser({ userId: user.id, blogId: id });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = authorizeSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('サイトURLを確認してください');
    }

    const env = getServerEnv();
    const appBaseUrl = process.env['APP_BASE_URL'];

    if (appBaseUrl === undefined || appBaseUrl.trim() === '') {
      // **リクエストの Host から作らない。** 偽の Host を送られると、
      // 戻り先を攻撃者のドメインへ差し替えられる（B-11 と同じ）
      throw new AppError(
        'CONFIGURATION_ERROR',
        503,
        'APP_BASE_URL が設定されていません',
      );
    }

    // **サイトURLの正規化は `createAuthorizeState` が行う**（形式が
    // 不正ならそこで 422 になる）。ここで先に整えると二重になる
    const state = createAuthorizeState(
      { userId: user.id, blogId: blog.id, siteUrl: parsed.data.siteUrl },
      { secret: env.SESSION_SECRET },
    );

    const authorizeUrl = buildAuthorizeUrl({
      siteUrl: parsed.data.siteUrl,
      successUrl: new URL(
        `/api/blogs/${blog.id}/wordpress/authorized`,
        appBaseUrl,
      ).toString(),
      state,
    });

    return Response.json({ authorizeUrl });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
