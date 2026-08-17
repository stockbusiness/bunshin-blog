import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { MAX_CSV_BYTES, decodeCsvBytes, parseCsv } from '@/lib/csv';
import {
  NOT_OUR_BLOG,
  applyResultMapping,
  sanitizeResultMapping,
  saveWeeklyResultsForUser,
  suggestResultColumnMapping,
  summarizeResultCsv,
  type ResultColumnMapping,
  type ResultCsvBlog,
  type ResultCsvSummary,
} from '@/modules/analytics';
import { recordAudit } from '@/modules/audit';
import { requireConsentedUser } from '@/modules/auth';
import { listOffersForUser } from '@/modules/affiliate';
import { listBlogsForUser } from '@/modules/blogs';
import { createConfiguredAiProvider } from '@/modules/settings';

/**
 * `POST /api/results/import`（Q-059、Q-058）
 *
 * ASPの成果レポート（CSV）を読んで、**週ごとの成果にまとめる。**
 *
 * ## ここで組み合わせる
 *
 * ブログは `blogs`、案件名は `affiliate`、集計は `analytics`。
 * **順に呼ぶのは上位の仕事**（MODULE_RULES 3）。
 *
 * ## `preview` は書かない
 *
 * まとめた結果を返すだけ。**書き込むのは `register`。**
 * 90日の実験の一次データを、見ないまま上書きさせない
 * （Q-058 の「最終GOはユーザーがする」）。
 *
 * ## `register` でAIを呼ばない
 *
 * 対応づけは `preview` が返したものを送り返させる。
 * **書き込みの直前にAIを呼ぶと、`preview` で見た表と違うものが保存されうる。**
 *
 * ## 割り当てが残っていたら書かない
 *
 * どのブログの成果か決まっていない行があるまま書くと、
 * **その週が「0件」として記録される**（`summarizeResultCsv` は覆う期間の
 * 週を0で埋める）。**取りこぼしを0件と書かない**ため、ここで断る。
 */

export const runtime = 'nodejs';

const mappingSchema = z.record(z.string(), z.number().int());

/** 案件名 → ブログID、または `NONE`（この実験のブログではない） */
const assignmentsSchema = z.record(z.string(), z.string().min(1).max(100));

const previewSchema = z.object({
  action: z.literal('preview'),
  /** Base64。**multipart を解かない**（上げるのは1つだけ） */
  csv: z.string().min(1),
  /** 人が直した対応づけ。無ければAIに推測させる */
  mapping: mappingSchema.optional(),
  assignments: assignmentsSchema.optional(),
});

const registerSchema = z.object({
  action: z.literal('register'),
  csv: z.string().min(1),
  /** **`preview` が返したものを送り返す。** ここでAIを呼ばない */
  mapping: mappingSchema,
  assignments: assignmentsSchema.optional(),
});

const bodySchema = z.discriminatedUnion('action', [
  previewSchema,
  registerSchema,
]);

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.validationFailed('入力を確かめてください');
    }

    const blogs = await readBlogs(user.id);

    if (blogs.length === 0) {
      throw AppError.validationFailed(
        'ブログがまだありません。先にブログを作ってください',
      );
    }

    if (parsed.data.action === 'preview') {
      return Response.json(await preview(parsed.data, blogs));
    }

    return Response.json(await register(parsed.data, blogs, user.id));
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

/** 突き合わせに使う材料をそろえる（**登録済みの案件名**） */
async function readBlogs(userId: string): Promise<ResultCsvBlog[]> {
  const blogs = await listBlogsForUser(userId);

  return Promise.all(
    blogs.map(async (blog) => ({
      id: blog.id,
      name: blog.name,
      offerNames: (await listOffersForUser({ userId, blogId: blog.id })).map(
        (offer) => offer.name,
      ),
    })),
  );
}

async function preview(
  input: z.infer<typeof previewSchema>,
  blogs: ResultCsvBlog[],
): Promise<{
  headers: string[];
  mapping: ResultColumnMapping;
  summary: ResultCsvSummary;
}> {
  const table = parseCsv(decodeCsvBytes(decodeBase64(input.csv)));

  const mapping =
    input.mapping === undefined
      ? await suggestResultColumnMapping(table, {
          provider: await createConfiguredAiProvider(),
        })
      : sanitizeResultMapping(input.mapping, table.headers.length);

  return {
    headers: table.headers,
    mapping,
    summary: summarize(table, mapping, blogs, input.assignments),
  };
}

async function register(
  input: z.infer<typeof registerSchema>,
  blogs: ResultCsvBlog[],
  userId: string,
): Promise<{
  savedWeeks: number;
  blogs: { blogId: string; blogName: string; conversions: number }[];
}> {
  const table = parseCsv(decodeCsvBytes(decodeBase64(input.csv)));
  const mapping = sanitizeResultMapping(input.mapping, table.headers.length);
  const summary = summarize(table, mapping, blogs, input.assignments);

  // **取りこぼしを0件と書かない**（上記）
  if (summary.unassigned.length > 0) {
    throw AppError.validationFailed(
      'どのブログの成果か決まっていない案件があります。選んでから記録してください',
    );
  }

  if (summary.weekStarts.length === 0) {
    throw AppError.validationFailed(
      '記録できる成果がありませんでした。日付の列が合っているか確かめてください',
    );
  }

  await saveWeeklyResultsForUser(userId, summary);

  // **人が割り当てた回だけ残す**（Q-059、2026-08-17 の決定）。
  // 割当記憶を実装する条件（未割当が2週連続で全体の20%以上、または
  // 手動割当が週10件以上）を、ここから数える。
  //
  // **要らなかった回は残さない** — 正常系を全部残すと、
  // `audit_logs` から異常が見えなくなる
  const handAssigned = Object.keys(input.assignments ?? {}).length;

  if (handAssigned > 0) {
    await recordAudit({
      actorUserId: userId,
      action: 'RESULT_ASSIGNED_BY_HAND',
      entityType: 'user',
      entityId: userId,
      // **割合を出せる形で残す。** 件数だけだと分母が分からない
      metadata: {
        handAssignedNames: handAssigned,
        totalRows: summary.totalRows,
        weeks: summary.weekStarts.length,
      },
    });
  }

  return {
    savedWeeks: summary.weekStarts.length,
    blogs: summary.blogs.map((blog) => ({
      blogId: blog.blogId,
      blogName: blog.blogName,
      conversions: blog.conversions,
    })),
  };
}

/**
 * まとめる。
 *
 * **知らないブログIDを黙って無視しない。** 無視すると、その案件の成果が
 * どこにも入らないまま**その週が「0件」として保存される。**
 */
function summarize(
  table: ReturnType<typeof parseCsv>,
  mapping: ResultColumnMapping,
  blogs: ResultCsvBlog[],
  assignments: Record<string, string> | undefined,
): ResultCsvSummary {
  if (assignments !== undefined) {
    const known = new Set([NOT_OUR_BLOG, ...blogs.map((blog) => blog.id)]);

    for (const blogId of Object.values(assignments)) {
      if (!known.has(blogId)) {
        throw AppError.validationFailed('選んだブログが見つかりません');
      }
    }
  }

  return summarizeResultCsv(applyResultMapping(table, mapping), blogs, {
    ...(assignments === undefined ? {} : { assignments }),
  });
}

function decodeBase64(value: string): Uint8Array {
  const buffer = Buffer.from(value, 'base64');

  if (buffer.byteLength === 0) {
    throw AppError.validationFailed('CSVが空です');
  }

  if (buffer.byteLength > MAX_CSV_BYTES) {
    throw AppError.validationFailed('CSVが大きすぎます。5MB以下にしてください');
  }

  return new Uint8Array(buffer);
}
