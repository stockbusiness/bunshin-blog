/**
 * CSVを読む共通の部品（Q-056 で `affiliate` に書いたものを持ち上げた）。
 *
 * ## なぜ `src/lib/` にあるのか
 *
 * CSVを読むところが**2か所になった。**
 *
 * | | 誰が上げるか | 何のCSVか |
 * |---|---|---|
 * | Q-056 | 運営 | ASPの提携プログラム一覧 |
 * | Q-059 | モニター | ASPの成果レポート |
 * <!-- prettier-ignore -->
 *
 * **RFC 4180 の解釈と文字コードの判定を2つ持つと、必ず片方だけ直す。**
 * `analytics` から `affiliate` を呼ぶ形にもできるが、
 * **CSVの読み方は業務の知識ではない**ので、共通基盤に置く
 * （MODULE_RULES：`src/lib/` は全モジュールが依存してよい）。
 *
 * **業務の知識はここに置かない。** 「報酬額の列はどれか」「否認とは何か」は
 * それぞれのモジュールが持つ。ここにあるのは
 * **バイト列 → 表 → 指定された列**までである。
 *
 * ## 依存を足さない
 *
 * CSVの解釈も文字コードの変換も自前で書く。
 * Shift_JIS は `TextDecoder('shift_jis')` で読める（Node は full-icu）。
 */

import { z } from 'zod';
import type { AiOperation, AiProvider } from '@/lib/ai';
import { AppError } from '@/lib/errors';

/** 受け取るCSVの上限。**ASPの一覧は大きい** */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** 読み込む行の上限。**画面で確かめられる量に収める** */
export const MAX_CSV_ROWS = 5_000;

/** AIへ見せる見本の行数。**多く見せても対応づけの精度は上がらない** */
const SAMPLE_ROWS = 3;

const TEMPERATURE_MAPPING = 0;

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** 読み飛ばした行数。**黙って切らない** */
  droppedRows: number;
}

/**
 * 文字コードを見て文字列にする。
 *
 * **日本のASPはたいてい Shift_JIS。** BOM付きUTF-8も、素のUTF-8もある。
 * `fatal` で読めなければ Shift_JIS とみなす — **推測はここだけに閉じる。**
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CSV_BYTES) {
    throw AppError.validationFailed('CSVが大きすぎます。5MB以下にしてください');
  }

  // BOM付きUTF-8
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/**
 * CSVを行と列へ分ける（RFC 4180 のかたち）。
 *
 * **囲みの中の改行とカンマを壊さない。** 案件名や否認条件に
 * 読点や改行が入ることがあり、単純に `split(',')` すると列がずれる。
 * **ずれたまま取り込むと、報酬額の列に案件名が入る。**
 */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  let droppedRows = 0;

  function endField(): void {
    row.push(field);
    field = '';
  }

  function endRow(): void {
    endField();

    // **空行を落とす。** 末尾の改行で1行増えるのを防ぐ
    if (row.length > 1 || row[0] !== '') {
      if (rows.length < MAX_CSV_ROWS + 1) {
        rows.push(row);
      } else {
        droppedRows += 1;
      }
    }

    row = [];
  }

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        // `""` は囲みの中の `"`
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        quoted = false;
        index += 1;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      endField();
      index += 1;
      continue;
    }

    if (char === '\r') {
      // CRLF も LF も同じ扱い
      if (text[index + 1] === '\n') {
        index += 1;
      }

      endRow();
      index += 1;
      continue;
    }

    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== '' || row.length > 0) {
    endRow();
  }

  const headers = rows.shift();

  if (headers === undefined) {
    throw AppError.validationFailed('CSVに中身がありません');
  }

  return { headers, rows, droppedRows };
}

/** 対応づける項目。`key` は呼び出し側の項目名 */
export interface CsvField<Key extends string> {
  key: Key;
  label: string;
  required?: boolean;
}

/** 項目 → 列の番号。**選ばなかった項目は入らない** */
export type ColumnMapping<Key extends string> = Partial<Record<Key, number>>;

export interface SuggestMappingDeps {
  provider: AiProvider;
  /** どの用途としてAIを呼ぶか（SPEC 9.8）。**lib側で決めない** */
  operation: AiOperation;
}

const mappingSchema = z.record(z.string(), z.number().int());

/**
 * 見出しから列の対応を推測する。
 *
 * **AIが返すのは列の番号だけ。値は返させない。**
 * 報酬額や日付をAIに書かせると、**CSVに無い数値**が入りうる。
 *
 * **範囲の外や知らない項目は落とす。** AIの答えをそのまま信じない。
 * **間違っても画面で直せる**（そこが人の仕事）。
 *
 * @throws {AppError} AIの応答が読めなかったとき
 */
export async function suggestColumnMapping<Key extends string>(
  table: CsvTable,
  fields: readonly CsvField<Key>[],
  deps: SuggestMappingDeps,
): Promise<ColumnMapping<Key>> {
  const preview = [
    table.headers.map((header, at) => `${String(at)}: ${header}`).join('\n'),
    '',
    '見本（先頭の行）:',
    ...table.rows
      .slice(0, SAMPLE_ROWS)
      .map((row) => row.map((cell) => truncateCell(cell)).join(' | ')),
  ].join('\n');

  const result = await deps.provider.complete({
    operation: deps.operation,
    system: [
      'あなたはCSVの見出しを、決められた項目へ対応づける係です。',
      '',
      '対応づける項目：',
      ...fields.map((field) => `- ${field.key}: ${field.label}`),
      '',
      '**列の番号だけを返してください。値は返さないでください。**',
      '当てはまる列が無い項目は、含めないでください。',
      '`{"項目名": 列番号}` の形のJSONだけを返してください。',
      '前置き・後書き・コードフェンスを付けないでください。',
    ].join('\n'),
    messages: [{ role: 'user', content: preview }],
    maxOutputTokens: 500,
    temperature: TEMPERATURE_MAPPING,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(result.text));
  } catch {
    // **応答本文を例外へ載せない**（SPEC 14.2）
    throw AppError.validationFailed(
      '列の対応を読み取れませんでした。手で選んでください',
    );
  }

  const record = mappingSchema.safeParse(parsed);

  if (!record.success) {
    throw AppError.validationFailed(
      '列の対応を読み取れませんでした。手で選んでください',
    );
  }

  return sanitizeMapping(record.data, fields, table.headers.length);
}

/**
 * AIの答えを信じすぎない。
 *
 * **知らない項目と、範囲の外の列番号を落とす。** 残ったものだけを使う。
 */
export function sanitizeMapping<Key extends string>(
  raw: Record<string, number>,
  fields: readonly CsvField<Key>[],
  columnCount: number,
): ColumnMapping<Key> {
  const known = new Set<string>(fields.map((field) => field.key));
  const mapping: ColumnMapping<Key> = {};

  for (const [key, at] of Object.entries(raw)) {
    if (!known.has(key) || !Number.isInteger(at)) {
      continue;
    }

    if (at < 0 || at >= columnCount) {
      continue;
    }

    mapping[key as Key] = at;
  }

  return mapping;
}

/** 対応づけた列を読む。**選ばれていない項目は空文字** */
export function readCell(
  row: readonly string[],
  at: number | undefined,
): string {
  return at === undefined ? '' : (row[at] ?? '');
}

/**
 * 金額らしい文字列から数を取り出す。
 *
 * **「1,480円」「1480」「¥1,480」を同じに読む。**
 * **割合（10%）は読まない** — 金額でないものを金額として扱うと、
 * 足切りも集計も意味を失う。
 */
export function readYenAmount(value: string): number | null {
  const text = value.trim();

  if (text === '' || text.includes('%') || text.includes('％')) {
    return null;
  }

  const digits = text.replace(/[^\d]/g, '');

  if (digits === '') {
    return null;
  }

  const parsed = Number.parseInt(digits, 10);

  return Number.isNaN(parsed) ? null : parsed;
}

function truncateCell(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/** コードフェンスが付いてきた場合に剥がす（`offer-draft` と同じ） */
function stripFence(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}
