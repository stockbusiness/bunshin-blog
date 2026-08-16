/**
 * ASPが書き出したCSVから案件の候補を作る（Q-056、Q-055）。
 *
 * ## なぜCSVなのか
 *
 * **AIがASPから直接集めることはできない。** 管理画面はログインが要り、
 * 公開APIを持つASPは限られ、自動巡回は規約違反になりうる
 * （**成果を無効にされると取り返しがつかない**）。
 *
 * **どのASPも提携プログラムをCSVで書き出せる。** そこを入口にする。
 *
 * ## 「膨大」の大半は足切りで解ける
 *
 * SPEC 9.2.3 の足切り（報酬額・成果地点・否認条件・掲載禁止）で
 * **数千件が数十件になる。** 判定は `content-planning` の
 * `findExclusion` をそのまま使う — **正しさを2か所に持たない。**
 *
 * ここは**読んで形をそろえるところまで。** 足切りは上位が組む
 * （MODULE_RULES 3。`affiliate` から `content-planning` へは依存できない）。
 *
 * ## AIにやらせるのは「列の対応づけ」だけ
 *
 * ASPごとに見出しが違う（「報酬額」「成果報酬」「単価」…）。
 * **AIが返すのは列の番号だけで、値は返さない。**
 * 報酬額も成果条件も**CSVの値をそのまま**使う —
 * AIに数値を作らせると、**ありもしない報酬額**が記事に載る。
 *
 * ## 依存を足さない
 *
 * CSVの解釈も文字コードの変換も自前で書く。
 * Shift_JIS は `TextDecoder('shift_jis')` で読める（Node は full-icu）。
 */

import { z } from 'zod';
import type { AiOperation, AiProvider } from '@/lib/ai';
import { AppError } from '@/lib/errors';
import type { ConversionType, UserExperience } from './types';

/** 受け取るCSVの上限。**ASPの一覧は大きい** */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** 読み込む行の上限。**画面で確かめられる量に収める** */
export const MAX_CSV_ROWS = 5_000;

/** AIへ見せる見本の行数。**多く見せても対応づけの精度は上がらない** */
const SAMPLE_ROWS = 3;

/** 対応づけは判断ではなく写し取り（SPEC 9.8） */
const OPERATION: AiOperation = 'FACT_CLAIM_EXTRACT';

const TEMPERATURE_MAPPING = 0;

/**
 * こちらの項目。
 *
 * **`facts` はここに無い。** 価格や条件はCSVにたいてい入っておらず、
 * **足切りを通ったものだけLPから読む**（Q-053）。
 * 数千件のLPを読むと費用が跳ねる。
 */
export const CSV_FIELDS = [
  { key: 'name', label: '案件の名前', required: true },
  { key: 'advertiserName', label: '広告主', required: false },
  { key: 'landingPageUrl', label: '紹介先のページ', required: true },
  { key: 'rewardYen', label: '報酬額（円）', required: false },
  { key: 'conversionType', label: '成果になる条件', required: false },
  { key: 'denyConditions', label: '否認条件', required: false },
  { key: 'status', label: '提携の状態', required: false },
] as const;

export type CsvFieldKey = (typeof CSV_FIELDS)[number]['key'];

/** 項目 → 列の番号。**選ばなかった項目は入らない** */
export type ColumnMapping = Partial<Record<CsvFieldKey, number>>;

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

export interface SuggestMappingDeps {
  provider: AiProvider;
}

const mappingSchema = z.record(z.string(), z.number().int());

/**
 * 見出しから列の対応を推測する。
 *
 * **AIが返すのは列の番号だけ。値は返させない。**
 * 報酬額や成果条件をAIに書かせると、**CSVに無い数値**が入りうる。
 *
 * **範囲の外や知らない項目は落とす。** AIの答えをそのまま信じない。
 * **間違っても画面で直せる**（そこが人の仕事）。
 *
 * @throws {AppError} AIの応答が読めなかったとき
 */
export async function suggestColumnMapping(
  table: CsvTable,
  deps: SuggestMappingDeps,
): Promise<ColumnMapping> {
  const preview = [
    table.headers.map((header, at) => `${String(at)}: ${header}`).join('\n'),
    '',
    '見本（先頭の行）:',
    ...table.rows
      .slice(0, SAMPLE_ROWS)
      .map((row) => row.map((cell) => truncateCell(cell)).join(' | ')),
  ].join('\n');

  const result = await deps.provider.complete({
    operation: OPERATION,
    system: [
      'あなたはCSVの見出しを、決められた項目へ対応づける係です。',
      '',
      '対応づける項目：',
      ...CSV_FIELDS.map((field) => `- ${field.key}: ${field.label}`),
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

  return sanitizeMapping(record.data, table.headers.length);
}

/**
 * AIの答えを信じすぎない。
 *
 * **知らない項目と、範囲の外の列番号を落とす。** 残ったものだけを使う。
 */
export function sanitizeMapping(
  raw: Record<string, number>,
  columnCount: number,
): ColumnMapping {
  const known = new Set<string>(CSV_FIELDS.map((field) => field.key));
  const mapping: ColumnMapping = {};

  for (const [key, at] of Object.entries(raw)) {
    if (!known.has(key) || !Number.isInteger(at)) {
      continue;
    }

    if (at < 0 || at >= columnCount) {
      continue;
    }

    mapping[key as CsvFieldKey] = at;
  }

  return mapping;
}

/** 取り込みの候補。**まだ保存しない** */
export interface ImportCandidate {
  /** CSVの何行目か（見出しを除く1始まり）。**画面で直すときの目印** */
  rowNumber: number;
  name: string;
  advertiserName: string | null;
  landingPageUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  denyConditions: string[];
  /** CSVの提携状態から推し量ったもの */
  status: string;
  /** 形が足りずに使えない理由。**黙って落とさない** */
  problem: string | null;
}

/**
 * CSVの成果条件らしい文字列を、こちらの区分へ寄せる。
 *
 * **分からなければ `OTHER`。** 推測で `FREE_SIGNUP` にすると、
 * 報酬800円未満の足切り（SPEC 9.2.3）が効いてしまう。
 */
export function readConversionType(value: string): ConversionType {
  const text = value.trim();

  if (/無料|登録|会員|申込|申し込み/.test(text)) {
    return 'FREE_SIGNUP';
  }

  if (/資料|請求|見積/.test(text)) {
    return 'REQUEST';
  }

  if (/体験|試用|お試し|トライアル/.test(text)) {
    return 'TRIAL';
  }

  if (/購入|販売|売上|注文/.test(text)) {
    return 'PURCHASE';
  }

  return 'OTHER';
}

/**
 * 報酬額らしい文字列から数を取り出す。
 *
 * **「1,480円」「1480」「¥1,480」を同じに読む。**
 * **割合（10%）は読まない** — 金額でないものを金額として扱うと、
 * 足切りが意味を失う。
 */
export function readRewardYen(value: string): number | null {
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

/**
 * CSVの提携状態を、`findExclusion` が見る状態へ寄せる。
 *
 * **終了・停止が読み取れたものだけ落とす。** 分からないものを
 * `ENDED` にすると、**使える案件が黙って消える。**
 */
export function readStatus(value: string): string {
  const text = value.trim();

  // **「一時停止」を先に見る。** 後に回すと「停止」に食われて
  // `ENDED` になり、**再開したら使える案件が消える**
  if (/一時|休止/.test(text)) {
    return 'PAUSED';
  }

  if (/終了|停止|解除|却下|否認/.test(text)) {
    return 'ENDED';
  }

  return 'ACTIVE';
}

/** 対応づけに沿って、行を候補へ写す */
export function applyMapping(
  table: CsvTable,
  mapping: ColumnMapping,
): ImportCandidate[] {
  return table.rows.map((row, index) => {
    const name = cell(row, mapping.name).trim();
    const landingPageUrl = cell(row, mapping.landingPageUrl).trim();

    return {
      rowNumber: index + 1,
      name,
      advertiserName: emptyToNull(cell(row, mapping.advertiserName)),
      landingPageUrl,
      rewardYen: readRewardYen(cell(row, mapping.rewardYen)),
      conversionType: readConversionType(cell(row, mapping.conversionType)),
      denyConditions: readDenyConditions(cell(row, mapping.denyConditions)),
      status: readStatus(cell(row, mapping.status)),
      problem: findProblem(name, landingPageUrl),
    };
  });
}

/**
 * 足切りに掛けられる形へ写す（`content-planning` の `ScorableOffer`）。
 *
 * **LPはまだ測っていない。** `lpEvaluatedAt` を `null` のままにすると
 * `findExclusion` は `lp_not_evaluated` を返す —
 * これは**「落ちた」ではなく「CSVの範囲では通った」**という印になる。
 */
export function toScorableShape(candidate: ImportCandidate): {
  id: string;
  name: string;
  advertiserName: string | null;
  conversionType: ConversionType;
  rewardYen: number | null;
  denyConditions: readonly string[];
  userExperience: UserExperience;
  lpFormFields: number | null;
  lpMobileReady: boolean | null;
  lpEvaluatedAt: Date | null;
  blogPostingProhibited: boolean;
  status: string;
} {
  return {
    id: String(candidate.rowNumber),
    name: candidate.name,
    advertiserName: candidate.advertiserName,
    conversionType: candidate.conversionType,
    rewardYen: candidate.rewardYen,
    denyConditions: candidate.denyConditions,
    // **CSVには「使ったことがあるか」が無い。** 採点では 0 点になる
    userExperience: 'UNKNOWN',
    lpFormFields: null,
    lpMobileReady: null,
    lpEvaluatedAt: null,
    // **CSVからは判断しない。** ASPの規約の判断（Q-019）で、人が決める
    blogPostingProhibited: false,
    status: candidate.status,
  };
}

function cell(row: readonly string[], at: number | undefined): string {
  return at === undefined ? '' : (row[at] ?? '');
}

function emptyToNull(value: string): string | null {
  const text = value.trim();

  return text === '' ? null : text;
}

/** 否認条件は改行か「・」「、」で区切られていることが多い */
function readDenyConditions(value: string): string[] {
  return value
    .split(/[\n・、;；]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** **使えない行を黙って落とさない。** 何が足りないかを画面へ出す */
function findProblem(name: string, landingPageUrl: string): string | null {
  if (name === '') {
    return '案件の名前が空です';
  }

  if (landingPageUrl === '') {
    return '紹介先のページが空です';
  }

  try {
    if (new URL(landingPageUrl).protocol !== 'https:') {
      return '紹介先のページが https で始まっていません';
    }
  } catch {
    return '紹介先のページがURLとして読めません';
  }

  return null;
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
