import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db';

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
}

export interface AppFactIssue {
  id: string;
  articleVersionId: string;
  severity: IssueSeverity;
  description: string;
  caughtBeforePublish: boolean;
  foundAt: Date;
  createdAt: Date;
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
    },
    select: {
      id: true,
      articleVersionId: true,
      severity: true,
      description: true,
      caughtBeforePublish: true,
      foundAt: true,
      createdAt: true,
    },
  });

  return { ...row, severity: row.severity as IssueSeverity };
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
  };
}

/** 新しい順に並べる。**直近に何が起きたかを先に見る** */
export async function listFactIssuesForAdmin(
  params: { limit?: number | undefined } = {},
): Promise<AppFactIssue[]> {
  const rows = await prisma.factIssue.findMany({
    orderBy: { foundAt: 'desc' },
    take: params.limit ?? 50,
    select: {
      id: true,
      articleVersionId: true,
      severity: true,
      description: true,
      caughtBeforePublish: true,
      foundAt: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    severity: row.severity as IssueSeverity,
  }));
}
