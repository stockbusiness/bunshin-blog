import { z } from 'zod';
import { toErrorHttpResponse } from '@/lib/errors';
import { requestAdminLoginLink } from '@/modules/auth';

/**
 * `POST /api/admin/login` ログインリンクの発行（TASKS B-11、SPEC 3.2）。
 *
 * **どの場合も同じ応答を返す。** 未登録・MONITOR・停止中・発行しすぎを
 * 区別すると、どのアドレスが管理者かを外から調べられる。理由はログのみ。
 */

export const runtime = 'nodejs';

const requestSchema = z.object({
  email: z.string().min(1).max(254),
});

/** 成否によらず返す文言 */
const ACCEPTED_MESSAGE =
  '登録済みの管理者アドレスであれば、ログインリンクを送信しました。メールをご確認ください';

function accepted(): Response {
  return Response.json({ message: ACCEPTED_MESSAGE }, { status: 202 });
}

export async function POST(request: Request): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // 形式不正も同じ応答にする。総当たりの手掛かりを与えない
      return accepted();
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return accepted();
    }

    // 結果を見ずに同じ応答を返す。内訳はログに残る
    await requestAdminLoginLink(parsed.data.email);

    return accepted();
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
