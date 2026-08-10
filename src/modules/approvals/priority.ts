/**
 * 提案の優先順位（TASKS F-1、SPEC 9.1「3ブログ横断で優先順位を付ける」）。
 *
 * ## 点の付け方は仕様に無い
 *
 * SPEC は `priority_score integer` と「3ブログ横断で優先順位を付ける」しか
 * 定めていない。**式そのものは判断で置いた**（Q-024 に記録）。
 * 置いた根拠は次の3つ。
 *
 * 1. **順番は既に決まっている。** E-9 が `publish_priority` を付けており、
 *    収益記事の先行も週の割り当てもそこに入っている。**同じ判断を二度しない**
 * 2. **1日1件しか送れない**（SPEC 8.3）。3ブログのうち1つが勝ち続けると、
 *    残り2つのブログは永久に進まない。**待たせている側を上げる**
 * 3. **返事が来ていないのに次を積まない。** 未回答の提案があるブログを下げる
 *
 * ## AIに点を付けさせない
 *
 * 入口に AI を渡す引数を置いていない。優先順位は「どの記事を人に見せるか」を
 * 決めるもので、**理由を後から説明できる必要がある**。
 *
 * DBも外部も触らない純粋な処理。
 */

/** 公開順序1番の記事に与える点 */
const PUBLISH_ORDER_BASE = 100;
/** 公開順序が1つ下がるごとに引く点 */
const PUBLISH_ORDER_STEP = 5;

/** 一度も提案していないブログに与える点 */
export const NEVER_PROPOSED_POINTS = 30;
/** 前回の提案からの経過日数1日あたりの点 */
const WAITING_POINTS_PER_DAY = 2;
/** 経過日数として数える上限（日） */
const WAITING_DAYS_CAP = 14;

/** 未回答の提案1件あたり引く点 */
const OPEN_PROPOSAL_PENALTY = 25;
/** 未回答として数える上限（件） */
const OPEN_PROPOSAL_CAP = 2;

/** 事実チェックが `WARNING` のときに引く点 */
const FACT_WARNING_PENALTY = 5;
/** `warning` のリスクフラグ1件あたり引く点 */
const RISK_FLAG_PENALTY = 3;
/** リスクフラグとして数える上限（件） */
const RISK_FLAG_CAP = 3;

export interface ProposalCandidate {
  contentItemId: string;
  blogId: string;
  articleVersionId: string;
  title: string;
  contentType: string;
  objective: string;
  /** 構成表が決めた公開順（E-9） */
  publishPriority: number;
  /** この記事から張る内部リンクの本数 */
  outboundLinkCount: number;
  factCheckStatus: string;
  /** `warning` のリスクフラグの件数（`error` があるものは候補に入らない） */
  warningFlagCount: number;
}

export interface BlogProposalState {
  blogId: string;
  blogName: string;
  /** 前回この ブログの提案を送った日時。一度も無ければ `null` */
  lastProposedAt: Date | null;
  /** まだ返事の無い提案の件数 */
  openProposalCount: number;
}

/** 公開順序からの点。**構成表の判断をそのまま使う** */
export function publishOrderPoints(publishPriority: number): number {
  const steps = Math.max(0, publishPriority - 1) * PUBLISH_ORDER_STEP;

  return Math.max(0, PUBLISH_ORDER_BASE - steps);
}

/**
 * 待たせているブログを上げる点。
 *
 * **1日1件しか送れないため**（SPEC 8.3）、ここが無いと3ブログのうち
 * 1つだけが進み続ける。
 */
export function waitingPoints(params: {
  lastProposedAt: Date | null;
  now: Date;
}): number {
  if (params.lastProposedAt === null) {
    return NEVER_PROPOSED_POINTS;
  }

  const days = Math.floor(
    (params.now.getTime() - params.lastProposedAt.getTime()) /
      (24 * 60 * 60 * 1_000),
  );

  return Math.max(0, Math.min(days, WAITING_DAYS_CAP)) * WAITING_POINTS_PER_DAY;
}

/**
 * 未回答の提案があるブログを下げる点（負の値）。
 *
 * **返事が来ていないのに次を積まない。** 積むと承認一覧が溜まり、
 * どれから見ればよいか分からなくなる。
 */
export function openProposalPenalty(openProposalCount: number): number {
  const counted = Math.min(Math.max(0, openProposalCount), OPEN_PROPOSAL_CAP);

  // **`-x` と書かない。** 0件のとき `-0` になり、JSON へ出すと `-0` が
  // そのまま残る
  return 0 - counted * OPEN_PROPOSAL_PENALTY;
}

/**
 * 手のかかる記事を少し下げる点（負の値）。
 *
 * **落とすためではない。** `FAILED` と `error` は候補に入らない（E-12・E-13）。
 * ここで見るのは「人が確かめる手間が多い」ことだけで、**同点なら
 * 手のかからないほうを先に見せる**という程度の重み。
 */
export function riskPenalty(params: {
  factCheckStatus: string;
  warningFlagCount: number;
}): number {
  const factPenalty =
    params.factCheckStatus === 'WARNING' ? FACT_WARNING_PENALTY : 0;
  const flagPenalty =
    Math.min(Math.max(0, params.warningFlagCount), RISK_FLAG_CAP) *
    RISK_FLAG_PENALTY;

  // `-0` を作らない（`openProposalPenalty` と同じ理由）
  return 0 - (factPenalty + flagPenalty);
}

/** 記事1本の優先度 */
export function scoreCandidate(params: {
  candidate: ProposalCandidate;
  blog: BlogProposalState;
  now: Date;
}): number {
  return (
    publishOrderPoints(params.candidate.publishPriority) +
    waitingPoints({
      lastProposedAt: params.blog.lastProposedAt,
      now: params.now,
    }) +
    openProposalPenalty(params.blog.openProposalCount) +
    riskPenalty({
      factCheckStatus: params.candidate.factCheckStatus,
      warningFlagCount: params.candidate.warningFlagCount,
    })
  );
}

/**
 * 提案理由を組み立てる（`approvals.proposal_reason`）。
 *
 * **AIに書かせない。** 理由は点の付け方と一致していなければならず、
 * 書かせると「点は低いのに理由は強い」記事が生まれる。
 * SPEC 8.2 の通知フォーマットにある「目的：」に相当する。
 */
export function buildProposalReason(params: {
  candidate: ProposalCandidate;
  blog: BlogProposalState;
  now: Date;
}): string {
  const parts: string[] = [];

  if (
    params.candidate.contentType === 'AFFILIATE' ||
    params.candidate.contentType === 'COMPARISON'
  ) {
    parts.push('案件を紹介する収益記事です。');
  } else if (params.candidate.outboundLinkCount > 0) {
    parts.push('集客記事です。読者を収益記事へ誘導します。');
  } else {
    parts.push('集客記事です。');
  }

  parts.push(`構成表の公開順で${params.candidate.publishPriority}番目です。`);

  if (params.blog.lastProposedAt === null) {
    parts.push('このブログでは初めての提案です。');
  } else {
    const days = Math.floor(
      (params.now.getTime() - params.blog.lastProposedAt.getTime()) /
        (24 * 60 * 60 * 1_000),
    );

    if (days >= 1) {
      parts.push(`このブログへの提案は${days}日ぶりです。`);
    }
  }

  // **確かめる手間を先に伝える。** 開いてから気づくより早い
  if (params.candidate.factCheckStatus === 'WARNING') {
    parts.push('未確認の事実があります。内容をご確認ください。');
  }

  if (params.candidate.warningFlagCount > 0) {
    parts.push(
      `表現について${params.candidate.warningFlagCount}件の指摘があります。`,
    );
  }

  return parts.join('');
}

export interface ScoredProposal {
  candidate: ProposalCandidate;
  priorityScore: number;
  proposalReason: string;
}

/**
 * 3ブログ横断で順位を付ける（SPEC 9.1）。
 *
 * **点の高い順。** 同点は `blogId` と `contentItemId` で決める —
 * **呼ぶたびに順番が入れ替わらないようにする**（E-9 の並びと同じ考え）。
 */
export function rankProposals(params: {
  candidates: readonly ProposalCandidate[];
  blogs: readonly BlogProposalState[];
  now: Date;
}): ScoredProposal[] {
  const byBlog = new Map(params.blogs.map((blog) => [blog.blogId, blog]));
  const scored: ScoredProposal[] = [];

  for (const candidate of params.candidates) {
    const blog = byBlog.get(candidate.blogId);

    // **知らないブログの記事は落とす。** 呼び出し側の絞り込みが
    // 漏れていた場合に、他人のブログの記事を提案しないため
    if (blog === undefined) {
      continue;
    }

    scored.push({
      candidate,
      priorityScore: scoreCandidate({ candidate, blog, now: params.now }),
      proposalReason: buildProposalReason({ candidate, blog, now: params.now }),
    });
  }

  return scored.sort(
    (a, b) =>
      b.priorityScore - a.priorityScore ||
      a.candidate.blogId.localeCompare(b.candidate.blogId) ||
      a.candidate.contentItemId.localeCompare(b.candidate.contentItemId),
  );
}
