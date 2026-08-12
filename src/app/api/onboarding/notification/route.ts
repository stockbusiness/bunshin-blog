import { toErrorHttpResponse } from '@/lib/errors';
import { requireUser } from '@/modules/auth';
import {
  findNotificationScheduleForUser,
  fromNotificationTimeColumn,
  saveNotificationScheduleForUser,
} from '@/modules/users';

/**
 * `GET|PUT /api/onboarding/notification` 通知の曜日と時刻（TASKS H-2b、SPEC 8.3）。
 *
 * **`requireConsentedUser` を使わない。** オンボーディングの途中で開く
 * 画面で、同意より後の段だが**同意の直後に詰まらせない**ためここも
 * `requireUser` に揃える（H-2a の現在地と同じ）。
 *
 * **検証は `users` モジュールが持つ**（`normalizeNotificationSchedule`）。
 * ここで zod を重ねると、同じ規則が2か所になる。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request.headers.get('cookie'));
    const saved = await findNotificationScheduleForUser(user.id);

    return Response.json({
      schedule:
        saved === null
          ? null
          : {
              days: saved.days,
              time: fromNotificationTimeColumn(saved.time),
            },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: { message: 'リクエストの形式が不正です' } },
        { status: 400 },
      );
    }

    const schedule = await saveNotificationScheduleForUser(user.id, body);

    return Response.json({ schedule });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
