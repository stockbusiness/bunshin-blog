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
 * ## CSVの読み方はここに書かない
 *
 * 文字コードの判定もRFC 4180の解釈も `src/lib/csv.ts` にある。
 * **モニターが上げる成果レポート（Q-059）と同じものを使う** —
 * 2つ持つと、必ず片方だけ直す。
 */

import type { AiOperation } from '@/lib/ai';
import {
  decodeCsvBytes,
  parseCsv,
  readCell,
  readYenAmount,
  sanitizeMapping as sanitizeColumnMapping,
  suggestColumnMapping as suggestMapping,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  type ColumnMapping as GenericColumnMapping,
  type CsvTable,
  type SuggestMappingDeps as GenericSuggestMappingDeps,
} from '@/lib/csv';
import type { ConversionType, UserExperience } from './types';

export { decodeCsvBytes, parseCsv, MAX_CSV_BYTES, MAX_CSV_ROWS };
export type { CsvTable };

/** 対応づけは判断ではなく写し取り（SPEC 9.8） */
const OPERATION: AiOperation = 'FACT_CLAIM_EXTRACT';

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
export type ColumnMapping = GenericColumnMapping<CsvFieldKey>;

export type SuggestMappingDeps = Omit<GenericSuggestMappingDeps, 'operation'>;

/**
 * 見出しから列の対応を推測する（`src/lib/csv.ts`）。
 *
 * **どの用途としてAIを呼ぶかはここで決める。** 対応づけは判断ではなく
 * 写し取りなので `FACT_CLAIM_EXTRACT` に載せる（SPEC 9.8）。
 */
export async function suggestColumnMapping(
  table: CsvTable,
  deps: SuggestMappingDeps,
): Promise<ColumnMapping> {
  return suggestMapping(table, CSV_FIELDS, { ...deps, operation: OPERATION });
}

/** AIの答えを信じすぎない（`src/lib/csv.ts`） */
export function sanitizeMapping(
  raw: Record<string, number>,
  columnCount: number,
): ColumnMapping {
  return sanitizeColumnMapping(raw, CSV_FIELDS, columnCount);
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
 * 報酬額らしい文字列から数を取り出す（`readYenAmount` に委ねる）。
 *
 * **「1,480円」「1480」「¥1,480」を同じに読む。**
 * **割合（10%）は読まない** — 金額でないものを金額として扱うと、
 * 足切りが意味を失う。
 */
export function readRewardYen(value: string): number | null {
  return readYenAmount(value);
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
    const name = readCell(row, mapping.name).trim();
    const landingPageUrl = readCell(row, mapping.landingPageUrl).trim();

    return {
      rowNumber: index + 1,
      name,
      advertiserName: emptyToNull(readCell(row, mapping.advertiserName)),
      landingPageUrl,
      rewardYen: readRewardYen(readCell(row, mapping.rewardYen)),
      conversionType: readConversionType(readCell(row, mapping.conversionType)),
      denyConditions: readDenyConditions(readCell(row, mapping.denyConditions)),
      status: readStatus(readCell(row, mapping.status)),
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
