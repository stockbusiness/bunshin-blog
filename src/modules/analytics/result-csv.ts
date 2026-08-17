/**
 * ASPの成果レポート（CSV）から週次の成果を作る（Q-059、Q-058）。
 *
 * ## なぜCSVなのか
 *
 * **ASPの契約はユーザー単位**（Q-057 の最優先事項の答え）。成果データは
 * **本人のASPアカウントにしか無く、運営が代わりに入れられない。**
 * 一方で、どのASPも成果レポートをCSVで書き出せる。
 *
 * Q-058 の原則（**打たせない・決めるのは最終GOだけ**）に照らすと、
 * 数字を2つ打たせる代わりに **CSVを1つ上げて、内容を見て頷く**形になる。
 * 読み取りの部品は Q-056（運営側の案件CSV）と同じ `src/lib/csv.ts`。
 *
 * ## 数を作らない
 *
 * **AIがやるのは列の対応づけだけ。** 件数も金額もCSVの値を数え上げる。
 * AIに集計させると、**ありもしない成果**が実験の一次データに入る。
 *
 * ## 否認された行を数えない
 *
 * 成果レポートには「否認」「キャンセル」の行が混ざる。数えると
 * **報酬が実際より多く見える。** 落とした数は画面に出す（黙って落とさない）。
 *
 * ## どのブログの成果かを推測しすぎない
 *
 * ASPのアカウントは**この実験の外のサイトも持ちうる。** 案件名が
 * 登録済みの案件と一致した行だけ自動で割り当て、**分からない行は人に聞く。**
 * ここを推測で埋めると、**90日の一次データが静かに狂う。**
 *
 * ## 期間の中の「成果が無かった週」は0として書く
 *
 * CSVが覆う期間の中に行が無い週があれば、それは**0件だったという意味**で
 * ある（未報告ではない）。`metrics_daily` の「行が無い＝未報告」という
 * 読み方（`weekly-result.ts`）を保つため、**その週には0を書く。**
 */

import {
  addJstDays,
  isJstDate,
  startOfJstWeek,
  type JstDate,
} from '@/lib/datetime';
import { AppError } from '@/lib/errors';
import {
  readCell,
  readYenAmount,
  sanitizeMapping as sanitizeColumnMapping,
  suggestColumnMapping as suggestMapping,
  type ColumnMapping as GenericColumnMapping,
  type CsvTable,
  type SuggestMappingDeps as GenericSuggestMappingDeps,
} from '@/lib/csv';
import type { AiOperation } from '@/lib/ai';
import { saveWeeklyResultForUser, type WeeklyResult } from './weekly-result';

/** 対応づけは判断ではなく写し取り（SPEC 9.8。Q-056 と同じ） */
const OPERATION: AiOperation = 'FACT_CLAIM_EXTRACT';

/**
 * 一度に取り込める週の数。
 *
 * **「全期間」で書き出されたCSVをそのまま通さない。** 数年分の週へ
 * 0を書き込むことになり、実験の記録として意味を成さない。
 */
export const MAX_RESULT_WEEKS = 26;

/** 「この実験のブログではない」を表す割り当て */
export const NOT_OUR_BLOG = 'NONE';

/** こちらの項目 */
export const RESULT_CSV_FIELDS = [
  { key: 'occurredOn', label: '成果が発生した日', required: true },
  { key: 'offerName', label: '案件（プログラム）の名前', required: false },
  { key: 'rewardYen', label: '報酬額（円）', required: false },
  { key: 'status', label: '成果の状態（承認・否認など）', required: false },
] as const;

export type ResultCsvFieldKey = (typeof RESULT_CSV_FIELDS)[number]['key'];

export type ResultColumnMapping = GenericColumnMapping<ResultCsvFieldKey>;

export type SuggestResultMappingDeps = Omit<
  GenericSuggestMappingDeps,
  'operation'
>;

/** 見出しから列の対応を推測する（`src/lib/csv.ts`） */
export async function suggestResultColumnMapping(
  table: CsvTable,
  deps: SuggestResultMappingDeps,
): Promise<ResultColumnMapping> {
  return suggestMapping(table, RESULT_CSV_FIELDS, {
    ...deps,
    operation: OPERATION,
  });
}

/** AIの答えを信じすぎない（`src/lib/csv.ts`） */
export function sanitizeResultMapping(
  raw: Record<string, number>,
  columnCount: number,
): ResultColumnMapping {
  return sanitizeColumnMapping(raw, RESULT_CSV_FIELDS, columnCount);
}

/** 成果レポートの1行 */
export interface ResultCsvRow {
  /** CSVの何行目か（見出しを除く1始まり）。**画面で直すときの目印** */
  rowNumber: number;
  /** 発生日（JSTの暦日）。読めなければ `null` */
  occurredOn: JstDate | null;
  offerName: string;
  rewardYen: number | null;
  /** **否認・キャンセルなら数えない** */
  rejected: boolean;
  /** 使えない理由。**黙って落とさない** */
  problem: string | null;
}

const DATE_PATTERN = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/;

/**
 * 成果レポートの日付を、JSTの暦日として読む。
 *
 * **タイムゾーンを変換しない。** 日本のASPが書き出す日時は既にJSTで、
 * `new Date()` に食わせて変換すると**深夜の成果が前日の週へ移る。**
 * 年月日だけを取り、時刻は捨てる（週にまとめるので要らない）。
 *
 * `2026-08-17` `2026/8/17 12:34:56` `2026年8月17日` を同じに読む。
 */
export function readResultDate(value: string): JstDate | null {
  const matched = DATE_PATTERN.exec(value.normalize('NFKC').trim());

  if (matched === null) {
    return null;
  }

  const date = [
    matched[1],
    (matched[2] as string).padStart(2, '0'),
    (matched[3] as string).padStart(2, '0'),
  ].join('-');

  // **存在しない日付を通さない**（2026-02-30 など）
  return isJstDate(date) ? date : null;
}

/**
 * 成果の状態を「数えるか・数えないか」に寄せる。
 *
 * **否認のほうを先に見る。** 「非承認」には「承認」が含まれるので、
 * 承認から先に判定すると**否認された成果が売上として数えられる**
 * （Q-056 の「一時停止」が「停止」に食われたのと同じ形の間違い）。
 *
 * **分からないものは数える。** 状態の列が無いASPもあり、
 * 読めないものを落とすと**成果が黙って消える。**
 */
export function isRejectedResult(value: string): boolean {
  const text = value.normalize('NFKC').trim();

  return /否認|非承認|却下|キャンセル|取消|取り消し|無効|失効|返品/.test(text);
}

/**
 * 案件名を突き合わせるための形にする。
 *
 * ASPの成果レポートは「【公式】○○ でんき」、案件カタログは「○○でんき」の
 * ように**同じものを違う書き方で持つ。** 記号と空白と大小を落として比べる。
 */
export function normalizeOfferName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[【】[\]（）()「」『』・,.．、。/|｜-]/g, '')
    .trim();
}

/** 対応づけに沿って、行を読む */
export function applyResultMapping(
  table: CsvTable,
  mapping: ResultColumnMapping,
): ResultCsvRow[] {
  return table.rows.map((row, index) => {
    const rawDate = readCell(row, mapping.occurredOn);
    const occurredOn = readResultDate(rawDate);

    return {
      rowNumber: index + 1,
      occurredOn,
      offerName: readCell(row, mapping.offerName).trim(),
      rewardYen: readYenAmount(readCell(row, mapping.rewardYen)),
      rejected: isRejectedResult(readCell(row, mapping.status)),
      problem:
        occurredOn === null
          ? rawDate.trim() === ''
            ? '成果が発生した日が空です'
            : `成果が発生した日を読み取れません（${rawDate.trim().slice(0, 20)}）`
          : null,
    };
  });
}

/** 突き合わせに使うブログ。**案件名は登録済みのもの** */
export interface ResultCsvBlog {
  id: string;
  name: string;
  offerNames: readonly string[];
}

export interface ResultCsvWeek {
  weekStart: JstDate;
  conversions: number;
  revenueYen: number;
}

export interface ResultCsvBlogSummary {
  blogId: string;
  blogName: string;
  weeks: ResultCsvWeek[];
  conversions: number;
  revenueYen: number;
}

/** どのブログの成果か分からなかった行のまとまり */
export interface ResultCsvUnassigned {
  /** 割り当てを送り返すときの鍵（`normalizeOfferName` の結果） */
  key: string;
  /** 画面に出す名前。**CSVに書かれていたまま** */
  offerName: string;
  rows: number;
  revenueYen: number;
}

export interface ResultCsvSummary {
  blogs: ResultCsvBlogSummary[];
  unassigned: ResultCsvUnassigned[];
  /** CSVが覆う期間の週（古い順）。**この週にだけ書き込む** */
  weekStarts: JstDate[];
  /** 否認・キャンセルで数えなかった行 */
  rejectedRows: number;
  /** 日付が読めずに使えなかった行 */
  unreadable: { rowNumber: number; problem: string }[];
  totalRows: number;
}

/**
 * 行をブログごと・週ごとにまとめる。
 *
 * **保存しない。** 画面に出して、人が見てから書き込む（最終GO）。
 *
 * @param assignments 人が決めた「この案件名はどのブログか」。
 *   `NOT_OUR_BLOG` なら**この実験の成果として数えない**
 * @throws {AppError} CSVが覆う期間が長すぎるとき
 */
export function summarizeResultCsv(
  rows: readonly ResultCsvRow[],
  blogs: readonly ResultCsvBlog[],
  options: { assignments?: Record<string, string> } = {},
): ResultCsvSummary {
  const assignments = options.assignments ?? {};
  const byName = buildNameIndex(blogs);

  const unreadable: { rowNumber: number; problem: string }[] = [];
  const usable: DatedRow[] = [];
  let rejectedRows = 0;

  for (const row of rows) {
    if (row.problem !== null || row.occurredOn === null) {
      unreadable.push({
        rowNumber: row.rowNumber,
        problem: row.problem ?? '成果が発生した日が読めません',
      });
      continue;
    }

    usable.push({ ...row, occurredOn: row.occurredOn });

    if (row.rejected) {
      rejectedRows += 1;
    }
  }

  const weekStarts = weeksCovering(usable);

  // ブログ × 週の入れ物を、先に0で埋める。
  // **期間の中の「行が無い週」は0件という意味**（未報告ではない）
  const totals = new Map<string, Map<JstDate, ResultCsvWeek>>();

  for (const blog of blogs) {
    const weeks = new Map<JstDate, ResultCsvWeek>();

    for (const weekStart of weekStarts) {
      weeks.set(weekStart, { weekStart, conversions: 0, revenueYen: 0 });
    }

    totals.set(blog.id, weeks);
  }

  const unassigned = new Map<string, ResultCsvUnassigned>();

  for (const row of usable) {
    // **否認は数えない。** ただし週は覆う（0件の週として残る）
    if (row.rejected) {
      continue;
    }

    const key = normalizeOfferName(row.offerName);
    const blogId = assignments[key] ?? findBlogId(byName, key);

    if (blogId === undefined) {
      const found = unassigned.get(key);

      if (found === undefined) {
        unassigned.set(key, {
          key,
          offerName: row.offerName,
          rows: 1,
          revenueYen: row.rewardYen ?? 0,
        });
      } else {
        found.rows += 1;
        found.revenueYen += row.rewardYen ?? 0;
      }

      continue;
    }

    // **この実験の成果ではないと決めた行**（他所のサイトの成果）
    if (blogId === NOT_OUR_BLOG) {
      continue;
    }

    const week = totals.get(blogId)?.get(startOfJstWeek(row.occurredOn));

    if (week !== undefined) {
      week.conversions += 1;
      week.revenueYen += row.rewardYen ?? 0;
    }
  }

  return {
    blogs: blogs.map((blog) => {
      const weeks = [...(totals.get(blog.id)?.values() ?? [])];

      return {
        blogId: blog.id,
        blogName: blog.name,
        weeks,
        conversions: weeks.reduce((sum, week) => sum + week.conversions, 0),
        revenueYen: weeks.reduce((sum, week) => sum + week.revenueYen, 0),
      };
    }),
    unassigned: [...unassigned.values()].sort((a, b) => b.rows - a.rows),
    weekStarts,
    rejectedRows,
    unreadable,
    totalRows: rows.length,
  };
}

/** 日付が読めた行 */
type DatedRow = ResultCsvRow & { occurredOn: JstDate };

/**
 * CSVが覆う週を、古い順に並べる。
 *
 * **否認の行も期間には数える。** 否認しか無かった週は
 * 「0件だった週」であって「報告されなかった週」ではない。
 */
function weeksCovering(rows: readonly DatedRow[]): JstDate[] {
  const dates = rows.map((row) => row.occurredOn);

  if (dates.length === 0) {
    return [];
  }

  const first = startOfJstWeek(dates.reduce((a, b) => (a < b ? a : b)));
  const last = startOfJstWeek(dates.reduce((a, b) => (a > b ? a : b)));

  const weeks: JstDate[] = [];

  for (let cursor = first; cursor <= last; cursor = addJstDays(cursor, 7)) {
    if (weeks.length >= MAX_RESULT_WEEKS) {
      throw AppError.validationFailed(
        `CSVの期間が長すぎます。${String(MAX_RESULT_WEEKS)}週以内で書き出してください`,
      );
    }

    weeks.push(cursor);
  }

  return weeks;
}

/** 案件名 → ブログ。**同じ名前が2つのブログにあれば決められない** */
function buildNameIndex(
  blogs: readonly ResultCsvBlog[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  for (const blog of blogs) {
    for (const name of blog.offerNames) {
      const key = normalizeOfferName(name);

      if (key === '') {
        continue;
      }

      const found = index.get(key);

      if (found === undefined) {
        index.set(key, new Set([blog.id]));
      } else {
        found.add(blog.id);
      }
    }
  }

  return index;
}

/**
 * 案件名からブログを1つに決める。**決まらなければ `undefined`。**
 *
 * 完全一致で決まらないときだけ、**どちらかがもう一方を含む**形を見る
 * （「【公式】○○でんき申込」と「○○でんき」）。それでも2つ以上の
 * ブログに当たるなら**決めない** — 推測で入れると一次データが狂う。
 */
function findBlogId(
  index: Map<string, Set<string>>,
  key: string,
): string | undefined {
  if (key === '') {
    return undefined;
  }

  const exact = index.get(key);

  if (exact !== undefined) {
    return exact.size === 1 ? [...exact][0] : undefined;
  }

  const found = new Set<string>();

  for (const [known, blogIds] of index) {
    if (known.includes(key) || key.includes(known)) {
      for (const blogId of blogIds) {
        found.add(blogId);
      }
    }
  }

  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * まとめた結果を書き込む。
 *
 * **1週ずつ `saveWeeklyResultForUser` を通す。** 所有権の確認も、
 * 上限の確認も、月曜への丸めも**1か所に持つ**（`weekly-result.ts`）。
 *
 * @throws {AppError} 自分のブログでない・上限を超えている
 */
export async function saveWeeklyResultsForUser(
  userId: string,
  summary: ResultCsvSummary,
): Promise<WeeklyResult[]> {
  const saved: WeeklyResult[] = [];

  for (const blog of summary.blogs) {
    for (const week of blog.weeks) {
      saved.push(
        await saveWeeklyResultForUser(
          { userId, blogId: blog.blogId, weekStart: week.weekStart },
          { conversions: week.conversions, revenueYen: week.revenueYen },
        ),
      );
    }
  }

  return saved;
}
