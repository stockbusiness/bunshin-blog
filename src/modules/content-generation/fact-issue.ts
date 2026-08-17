import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db';
import {
  isJstDate,
  jstDateColumn,
  startOfJstWeek,
  toJstDate,
} from '@/lib/datetime';

/**
 * 事実誤認の記録と集計（TASKS J-7、OPEN_QUESTIONS Q-044、SPEC 16.2）。
 *
 * ## なぜ要るのか
 *
 * SPEC 16.2 は「**重大な事実誤認：承認・公開前に100%検知**」を目標に
 * している。**これを確かめるには、検知できなかったものを数える必要がある。**
 *
 * これまで記録されていたのは `article_versions.risk_flags` と
 * `unverified_claims`、つまり**機械が見つけたものだけ。**
 * **見逃したものはどこにも残らず、100%かどうかを言えなかった。**
 *
 * ## 率を出すのは「重大」だけ
 *
 * **SPEC 16.2 が見ているのは「重大な」事実誤認。** 軽微なものを混ぜると、
 * **誤字の多さで率が動く。** 軽微なものは記録するが、率には入れない。
 *
 * ## 1件も無いときに 100% と言わない
 *
 * 0件のときの割合は**計算できない**（0÷0）。**`null` を返す。**
 * 100% を返すと、**まだ何も起きていないことが「完璧だった」に見える。**
 */

export type IssueSeverity = 'MAJOR' | 'MINOR';

export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ['MAJOR', 'MINOR'];

/**
 * どこから見つかったか（2026-08-17 の決定）。
 *
 * **機械が見逃したのか、人が抜き取りで見つけたのか、読者に指摘されたのかで
 * 打つ手がまったく違う。** 混ぜると、どこを直せばよいか分からない。
 */
export type FactIssueSource =
  'MONITOR_REPORT' | 'SAMPLING' | 'OPERATOR' | 'READER' | 'OTHER';

export const FACT_ISSUE_SOURCES: readonly FactIssueSource[] = [
  'MONITOR_REPORT',
  'SAMPLING',
  'OPERATOR',
  'READER',
  'OTHER',
];

/** **記録しただけで直っていないのがいちばん悪い**（2026-08-17 の決定） */
export type FactIssueFixStatus =
  'NOT_STARTED' | 'IN_PROGRESS' | 'FIXED' | 'WONT_FIX';

export const FACT_ISSUE_FIX_STATUSES: readonly FactIssueFixStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'FIXED',
  'WONT_FIX',
];

/** 説明の最大の長さ。**あとから読んで分かる長さで書く** */
export const ISSUE_DESCRIPTION_MAX_LENGTH = 2_000;

export interface RecordFactIssueInput {
  articleVersionId: string;
  severity: IssueSeverity;
  description: string;
  /** **公開前に気づいたか。** 分子と分母を分ける唯一の値 */
  caughtBeforePublish: boolean;
  /** いつ見つけたか。**記録した時刻ではない** */
  foundAt: Date;
  /** 誰が見つけたか。**分からなければ `null`**（読者からの指摘など） */
  foundByUserId: string | null;
  /** どこから見つかったか。**省けない**（既定値を置いていない） */
  foundVia: FactIssueSource;
}

export interface AppFactIssue {
  id: string;
  articleVersionId: string;
  severity: IssueSeverity;
  description: string;
  caughtBeforePublish: boolean;
  foundAt: Date;
  foundVia: FactIssueSource;
  fixStatus: FactIssueFixStatus;
  fixedAt: Date | null;
  createdAt: Date;
}

const ISSUE_SELECT = {
  id: true,
  articleVersionId: true,
  severity: true,
  description: true,
  caughtBeforePublish: true,
  foundAt: true,
  foundVia: true,
  fixStatus: true,
  fixedAt: true,
  createdAt: true,
} as const;

function toAppIssue(row: {
  id: string;
  articleVersionId: string;
  severity: string;
  description: string;
  caughtBeforePublish: boolean;
  foundAt: Date;
  foundVia: string;
  fixStatus: string;
  fixedAt: Date | null;
  createdAt: Date;
}): AppFactIssue {
  return {
    ...row,
    severity: row.severity as IssueSeverity,
    foundVia: row.foundVia as FactIssueSource,
    fixStatus: row.fixStatus as FactIssueFixStatus,
  };
}

/**
 * 事実誤認を記録する。
 *
 * **`...ForAdmin`。** 利用者を横断して記録する（MODULE_RULES 5）。
 * モニターが見つけたものも ADMIN が代わりに入れる — **記録の形を
 * 揃えるため**（片方だけ別の経路にすると、集計が2か所を見ることになる）。
 */
export async function recordFactIssueForAdmin(
  input: RecordFactIssueInput,
): Promise<AppFactIssue> {
  const description = input.description.trim();

  // **空を弾くのはDBにもある**（CHECK 制約）。ここで先に弾くのは、
  // 画面へ理由を返すため（DBの違反はそのまま出せない）
  if (description === '') {
    throw AppError.validationFailed('何が誤っていたかを書いてください');
  }

  if (description.length > ISSUE_DESCRIPTION_MAX_LENGTH) {
    throw AppError.validationFailed(
      `${ISSUE_DESCRIPTION_MAX_LENGTH}文字以内で書いてください`,
    );
  }

  // **記事の版があることを先に確かめる。** 外部キー違反をそのまま
  // 返すと、画面に出せる文言にならない
  const version = await prisma.articleVersion.findUnique({
    where: { id: input.articleVersionId },
    select: { id: true },
  });

  if (version === null) {
    throw AppError.validationFailed('記事の版が見つかりません');
  }

  const row = await prisma.factIssue.create({
    data: {
      articleVersionId: input.articleVersionId,
      severity: input.severity,
      description,
      caughtBeforePublish: input.caughtBeforePublish,
      foundAt: input.foundAt,
      foundByUserId: input.foundByUserId,
      foundVia: input.foundVia,
    },
    select: ISSUE_SELECT,
  });

  return toAppIssue(row);
}

/**
 * 直したかを記録する。
 *
 * **`FIXED` にするには時刻が要る**（DBの CHECK と同じ規則）。
 * ここで断るのは、制約違反をそのまま画面に出せないため。
 *
 * @throws {AppError} 記録が無い・時刻が足りない
 */
export async function updateFactIssueFixForAdmin(
  id: string,
  input: { fixStatus: FactIssueFixStatus; fixedAt?: Date | undefined },
): Promise<AppFactIssue> {
  const current = await prisma.factIssue.findUnique({
    where: { id },
    select: { fixedAt: true },
  });

  if (current === null) {
    throw AppError.notFound('記録が見つかりません');
  }

  const fixedAt = input.fixedAt ?? current.fixedAt;

  if (input.fixStatus === 'FIXED' && fixedAt === null) {
    throw AppError.validationFailed('直した日時を入れてください');
  }

  const row = await prisma.factIssue.update({
    where: { id },
    data: { fixStatus: input.fixStatus, fixedAt },
    select: ISSUE_SELECT,
  });

  return toAppIssue(row);
}

export interface FactIssueSummary {
  /** 重大な誤りの総数（分母） */
  major: number;
  /** そのうち公開前に捕まえたもの（分子） */
  caughtBeforePublish: number;
  /**
   * 捕まえた割合。
   *
   * **1件も無ければ `null`。** 100% を返すと、まだ何も起きていない
   * ことが「完璧だった」に見える。
   */
  rate: number | null;
  /** 軽微な誤りの数。**率には入れない**（誤字の多さで率が動く） */
  minor: number;
  /**
   * まだ直していない誤りの数（重大・軽微を合わせる）。
   *
   * **記録しただけで直っていないのがいちばん悪い。**
   * 率とは別に、いま手を動かす対象として出す
   */
  unfixed: number;
}

/**
 * SPEC 16.2 の「承認・公開前に100%検知」を計算する。
 *
 * **重大なものだけで率を出す。**
 */
export async function summarizeFactIssuesForAdmin(): Promise<FactIssueSummary> {
  const rows = await prisma.factIssue.groupBy({
    by: ['severity', 'caughtBeforePublish'],
    _count: { _all: true },
  });

  // **直っていないものは別に数える。** 率の分母とは関係がない
  const unfixed = await prisma.factIssue.count({
    where: { fixStatus: { in: ['NOT_STARTED', 'IN_PROGRESS'] } },
  });

  let major = 0;
  let caught = 0;
  let minor = 0;

  for (const row of rows) {
    if (row.severity === 'MINOR') {
      minor += row._count._all;

      continue;
    }

    major += row._count._all;

    if (row.caughtBeforePublish) {
      caught += row._count._all;
    }
  }

  return {
    major,
    caughtBeforePublish: caught,
    rate: major === 0 ? null : caught / major,
    minor,
    unfixed,
  };
}

/** 新しい順に並べる。**直近に何が起きたかを先に見る** */
export async function listFactIssuesForAdmin(
  params: { limit?: number | undefined } = {},
): Promise<AppFactIssue[]> {
  const rows = await prisma.factIssue.findMany({
    orderBy: { foundAt: 'desc' },
    take: params.limit ?? 50,
    select: ISSUE_SELECT,
  });

  return rows.map(toAppIssue);
}

/**
 * 公開済み記事の抜き取り確認（2026-08-17 の決定）。
 *
 * ## なぜ記録するのか
 *
 * **`fact_issues` が空のとき、それが「誤りが無かった」のか
 * 「確かめていない」のかが分からない。**
 *
 * これは `fact_issues` 自身が解いた問題（見逃しがどこにも残らない）と
 * **同じ形**である。**確認したという事実を残さないかぎり、空の表は読めない。**
 *
 * ## 確認した週にだけ行を作る
 *
 * `metrics_daily` の「行が無い＝未報告」（Q-059）と同じ考え。
 * **0件で行を作らせない**（DBの CHECK が `reviewed_count > 0` を要求する）
 * — 0件の行は「確認していない」と同じ意味になり、区別が消える。
 */

/** 毎週確かめる目安（2026-08-17 の決定） */
export const FACT_REVIEW_TARGET_COUNT = 10;

/** 負荷が高くてもここまでは確かめる */
export const FACT_REVIEW_MIN_COUNT = 5;

export interface RecordFactReviewInput {
  /** JSTの月曜（`weekOf` と同じ扱い） */
  weekStart: string;
  reviewedCount: number;
  issueCount: number;
  note?: string | undefined;
  reviewedByUserId: string | null;
}

export interface AppFactReviewWeek {
  weekStart: string;
  reviewedCount: number;
  issueCount: number;
  note: string | null;
  updatedAt: Date;
}

function toAppReview(row: {
  weekStart: Date;
  reviewedCount: number;
  issueCount: number;
  note: string | null;
  updatedAt: Date;
}): AppFactReviewWeek {
  return {
    weekStart: row.weekStart.toISOString().slice(0, 10),
    reviewedCount: row.reviewedCount,
    issueCount: row.issueCount,
    note: row.note,
    updatedAt: row.updatedAt,
  };
}

const REVIEW_SELECT = {
  weekStart: true,
  reviewedCount: true,
  issueCount: true,
  note: true,
  updatedAt: true,
} as const;

/**
 * その週に確かめたことを記録する。**同じ週に入れ直すと上書きする。**
 *
 * @throws {AppError} 数が合わない・週の指定が読めない
 */
export async function recordFactReviewWeekForAdmin(
  input: RecordFactReviewInput,
): Promise<AppFactReviewWeek> {
  if (!isJstDate(input.weekStart)) {
    throw AppError.validationFailed('週の指定が正しくありません');
  }

  if (!Number.isInteger(input.reviewedCount) || input.reviewedCount < 1) {
    // **0件で行を作らせない。** 0件の行は「確認していない」と
    // 同じ意味になり、この表を作った理由が消える
    throw AppError.validationFailed('確かめた記事の数を1件以上にしてください');
  }

  if (!Number.isInteger(input.issueCount) || input.issueCount < 0) {
    throw AppError.validationFailed('見つけた数を確かめてください');
  }

  if (input.issueCount > input.reviewedCount) {
    throw AppError.validationFailed(
      '見つけた数が、確かめた数より多くなっています',
    );
  }

  const note = input.note?.trim();
  const data = {
    reviewedCount: input.reviewedCount,
    issueCount: input.issueCount,
    note: note === undefined || note === '' ? null : note,
    reviewedByUserId: input.reviewedByUserId,
  };

  const row = await prisma.factReviewWeek.upsert({
    where: { weekStart: jstDateColumn(input.weekStart) },
    // **`date` 型の列には暦日をそのまま渡す**（Q-031）
    create: { ...data, weekStart: jstDateColumn(input.weekStart) },
    update: data,
    select: REVIEW_SELECT,
  });

  return toAppReview(row);
}

/** 新しい週が先 */
export async function listFactReviewWeeksForAdmin(
  params: { limit?: number | undefined } = {},
): Promise<AppFactReviewWeek[]> {
  const rows = await prisma.factReviewWeek.findMany({
    orderBy: { weekStart: 'desc' },
    take: params.limit ?? 12,
    select: REVIEW_SELECT,
  });

  return rows.map(toAppReview);
}

export interface FactReviewSummary {
  /** 直近の確認。**一度も無ければ `null`** */
  latest: AppFactReviewWeek | null;
  /** 今週すでに確かめたか。**確かめていなければ促す** */
  reviewedThisWeek: boolean;
  /** 確認した週の数 */
  weeks: number;
  /** 確かめた記事の総数 */
  reviewedTotal: number;
}

/**
 * 抜き取り確認の状況をまとめる。
 *
 * **「今週まだ確かめていない」を出すためのもの。**
 * 出さないと、`fact_issues` が空のまま週が流れる。
 */
export async function summarizeFactReviewForAdmin(
  now: Date = new Date(),
): Promise<FactReviewSummary> {
  const [latest, aggregate] = await Promise.all([
    prisma.factReviewWeek.findFirst({
      orderBy: { weekStart: 'desc' },
      select: REVIEW_SELECT,
    }),
    prisma.factReviewWeek.aggregate({
      _count: { _all: true },
      _sum: { reviewedCount: true },
    }),
  ]);

  const thisWeek = startOfJstWeek(toJstDate(now));

  return {
    latest: latest === null ? null : toAppReview(latest),
    reviewedThisWeek:
      latest !== null && toAppReview(latest).weekStart === thisWeek,
    weeks: aggregate._count._all,
    reviewedTotal: aggregate._sum.reviewedCount ?? 0,
  };
}
