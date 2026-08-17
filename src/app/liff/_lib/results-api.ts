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

/** `NOT_OUR_BLOG`（サーバー側と同じ値。**型を借りない**） */
export const NOT_OUR_BLOG = 'NONE';

export interface ResultCsvWeekJson {
  weekStart: string;
  conversions: number;
  revenueYen: number;
}

export interface ResultCsvBlogJson {
  blogId: string;
  blogName: string;
  weeks: ResultCsvWeekJson[];
  conversions: number;
  revenueYen: number;
}

export interface ResultCsvUnassignedJson {
  key: string;
  offerName: string;
  rows: number;
  revenueYen: number;
}

export interface ResultCsvSummaryJson {
  blogs: ResultCsvBlogJson[];
  unassigned: ResultCsvUnassignedJson[];
  weekStarts: string[];
  rejectedRows: number;
  unreadable: { rowNumber: number; problem: string }[];
  totalRows: number;
}

export interface ResultCsvPreviewJson {
  headers: string[];
  mapping: Record<string, number>;
  summary: ResultCsvSummaryJson;
}

async function postImport(body: unknown): Promise<unknown> {
  const response = await fetch('/api/results/import', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await readError(response);
  }

  return response.json();
}

/** CSVを読んで、まとめた結果を返す。**まだ書き込まない** */
export async function previewResultCsv(input: {
  csv: string;
  mapping?: Record<string, number>;
  assignments?: Record<string, string>;
}): Promise<ResultCsvPreviewJson> {
  return (await postImport({
    action: 'preview',
    ...input,
  })) as ResultCsvPreviewJson;
}

/** 見た内容をそのまま書き込む（最終GO）。**対応づけは送り返す** */
export async function registerResultCsv(input: {
  csv: string;
  mapping: Record<string, number>;
  assignments?: Record<string, string>;
}): Promise<{ savedWeeks: number; blogs: { blogName: string }[] }> {
  return (await postImport({ action: 'register', ...input })) as {
    savedWeeks: number;
    blogs: { blogName: string }[];
  };
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
