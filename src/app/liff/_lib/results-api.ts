/**
 * `/api/blogs/[blogId]/results` をブラウザから呼ぶ（G-5）。
 *
 * **サーバー側の型を借りない**（`blogs-api.ts` と同じ理由）。
 */

export interface WeeklyResultJson {
  /** `YYYY-MM-DD`（JSTの月曜） */
  weekStart: string;
  conversions: number;
  revenueYen: number;
  /** **報告されたか。** `false` なら未入力（0件の報告と区別する） */
  reported: boolean;
}

export class ResultApiError extends Error {
  override readonly name = 'ResultApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;

  throw new ResultApiError(
    response.status,
    typeof body?.message === 'string' ? body.message : '読み込めませんでした',
  );
}

export async function fetchWeeklyResults(
  blogId: string,
): Promise<{ results: WeeklyResultJson[] }> {
  const response = await fetch(
    `/api/blogs/${encodeURIComponent(blogId)}/results`,
    { headers: { accept: 'application/json' } },
  );

  if (!response.ok) {
    await readError(response);
  }

  return (await response.json()) as { results: WeeklyResultJson[] };
}

export async function saveWeeklyResult(
  blogId: string,
  input: { conversions: number; revenueYen: number },
): Promise<void> {
  const response = await fetch(
    `/api/blogs/${encodeURIComponent(blogId)}/results`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    await readError(response);
  }
}
