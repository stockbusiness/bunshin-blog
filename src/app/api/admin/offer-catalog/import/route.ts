import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import {
  MAX_CSV_BYTES,
  applyMapping,
  createCatalogItemForAdmin,
  decodeCsvBytes,
  parseCsv,
  sanitizeMapping,
  suggestColumnMapping,
  toScorableShape,
  type ColumnMapping,
  type ImportCandidate,
} from '@/modules/affiliate';
import { requireAdmin } from '@/modules/auth';
import {
  PARTNERSHIP_NOT_APPLICABLE,
  findExclusion,
} from '@/modules/content-planning';
import { createConfiguredAiProvider } from '@/modules/settings';

/**
 * `POST /api/admin/offer-catalog/import`（Q-056）
 *
 * ASPが書き出したCSVを読んで、**足切りを通った候補を返す。ADMIN だけ。**
 *
 * ## ここで足切りを組む
 *
 * 判定は `content-planning` の `findExclusion`、読み取りは `affiliate`。
 * **順に呼ぶのは上位の仕事**（MODULE_RULES 3。
 * `affiliate` から `content-planning` へは依存できない）。
 *
 * ## 保存しない
 *
 * **`preview` は読むだけ。** 画面に出して、**人が確かめてから**
 * `register` で登録する。数千件をまとめて入れるので、
 * **確かめずに保存すると間違いがそのまま広がる。**
 *
 * ## `lp_not_evaluated` は「落ちた」ではない
 *
 * LPをまだ測っていないという印で、**CSVの範囲では通った**という意味。
 * ここではそれを「残った」として扱う。
 */

export const runtime = 'nodejs';

/** 一度に登録できる上限。**確かめられる量に収める** */
const MAX_REGISTER = 200;

const previewSchema = z.object({
  action: z.literal('preview'),
  /** Base64。**multipart を解かない**（上げるのは1つだけ） */
  csv: z.string().min(1),
  /** 人が直した対応づけ。無ければAIに推測させる */
  mapping: z.record(z.string(), z.number().int()).optional(),
});

const registerSchema = z.object({
  action: z.literal('register'),
  aspName: z.string().min(1).max(100),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        advertiserName: z.string().max(200).nullable(),
        landingPageUrl: z.string().url().max(2_000),
        rewardYen: z.number().int().min(0).max(10_000_000).nullable(),
        conversionType: z.enum([
          'FREE_SIGNUP',
          'REQUEST',
          'TRIAL',
          'PURCHASE',
          'OTHER',
        ]),
        denyConditions: z.array(z.string().max(200)).max(20),
      }),
    )
    .min(1)
    .max(MAX_REGISTER),
});

const bodySchema = z.discriminatedUnion('action', [
  previewSchema,
  registerSchema,
]);

export async function POST(request: Request): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

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

    if (parsed.data.action === 'preview') {
      return Response.json(await preview(parsed.data));
    }

    return Response.json(await register(parsed.data, admin.id));
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

async function preview(input: z.infer<typeof previewSchema>): Promise<{
  headers: string[];
  mapping: ColumnMapping;
  kept: ImportCandidate[];
  droppedByReason: Record<string, number>;
  totalRows: number;
  droppedRows: number;
}> {
  const bytes = decodeBase64(input.csv);
  const table = parseCsv(decodeCsvBytes(bytes));

  const mapping =
    input.mapping === undefined
      ? await suggestColumnMapping(table, {
          provider: await createConfiguredAiProvider(),
        })
      : sanitizeMapping(input.mapping, table.headers.length);

  const candidates = applyMapping(table, mapping);
  const kept: ImportCandidate[] = [];
  const droppedByReason: Record<string, number> = {};

  for (const candidate of candidates) {
    // **形が足りない行は、理由を付けて落とす**（画面に数を出す）
    if (candidate.problem !== null) {
      droppedByReason[candidate.problem] =
        (droppedByReason[candidate.problem] ?? 0) + 1;
      continue;
    }

    const reason = findExclusion({
      ...toScorableShape(candidate),
      // **提携は利用者ごと。** 運営がカタログを作る段階には存在しないので、
      // 「承認済み」とは書かない（嘘のデータになる。Q-060）
      partnershipStatus: PARTNERSHIP_NOT_APPLICABLE,
    });

    // **`lp_not_evaluated` は「CSVの範囲では通った」**
    if (reason !== null && reason !== 'lp_not_evaluated') {
      droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1;
      continue;
    }

    kept.push(candidate);
  }

  return {
    headers: table.headers,
    mapping,
    // **数が多いと画面で確かめられない。** 報酬の高い順に絞る
    kept: kept
      .slice()
      .sort((a, b) => (b.rewardYen ?? 0) - (a.rewardYen ?? 0))
      .slice(0, MAX_REGISTER),
    droppedByReason,
    totalRows: candidates.length,
    droppedRows: table.droppedRows,
  };
}

async function register(
  input: z.infer<typeof registerSchema>,
  adminUserId: string,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;

  for (const item of input.items) {
    try {
      await createCatalogItemForAdmin(
        {
          ...item,
          aspName: input.aspName,
          // **事実はここで入れない。** LPから読んで人が確かめる（Q-053）。
          // 空のまま登録されるので、`DRAFT` から動かせない
          facts: [],
          status: 'DRAFT',
        },
        adminUserId,
      );
      added += 1;
    } catch (error) {
      // **すでに在るものは飛ばす。** 取り込みを二度流しても壊れない
      if (error instanceof AppError && error.status === 409) {
        skipped += 1;
        continue;
      }

      throw error;
    }
  }

  return { added, skipped };
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
