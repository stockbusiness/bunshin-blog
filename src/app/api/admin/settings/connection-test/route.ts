import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import {
  CONNECTION_TARGETS,
  testConnectionForAdmin,
  type ConnectionTarget,
} from '@/modules/settings';

/**
 * `POST /api/admin/settings/connection-test`（TASKS H-9、H-8）
 *
 * **保存前の値で試せる。** 画面で入力しただけの値を `overrides` で受け取り、
 * 保存せずに試す（誤った鍵を保存してから気づく順序にしない）。
 *
 * **繋がらなくても 200 を返す。** テストの実行そのものは成功していて、
 * 結果が「繋がらない」なだけ。HTTPのエラーにすると、実行できなかった
 * 場合と区別がつかなくなる（C-2 の接続テストと同じ扱い）。
 *
 * 静的な `connection-test` は `[key]` より先に解決される。設定名は
 * 大文字のみ（`app_settings_key_format`）なので取り違えは起きない。
 */

export const runtime = 'nodejs';

function readTarget(body: unknown): ConnectionTarget {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['target']
      : undefined;

  if (
    typeof value !== 'string' ||
    !(CONNECTION_TARGETS as readonly string[]).includes(value)
  ) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `試す相手を ${CONNECTION_TARGETS.join(' / ')} のいずれかで指定してください`,
    );
  }

  return value as ConnectionTarget;
}

/**
 * 入力途中の値を読む。
 *
 * **文字列以外は捨てる。** 検証は `testConnectionForAdmin` が名前について
 * 行い、値の形は相手側が判定する（ここで弾くと「保存前に試す」意味が薄れる）。
 */
function readOverrides(body: unknown): Record<string, string> {
  const raw =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['overrides']
      : undefined;

  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      overrides[key] = value;
    }
  }

  return overrides;
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    const body: unknown = await request.json().catch(() => null);

    const result = await testConnectionForAdmin({
      target: readTarget(body),
      overrides: readOverrides(body),
    });

    return Response.json({ result });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
