import { prisma } from '@/lib/db';

/**
 * 実験の集計（TASKS G-7、SPEC 10.3）。
 *
 * 完了条件は「**ジャンル別・戦略別・ブログ別の集計がSQLで取得できる**」。
 *
 * ## なぜモジュールではなく `src/app/` に置くか
 *
 * この集計は `metrics_daily`（`analytics`）・`blogs` / `genres`（`blogs`）・
 * `experiment_groups`（`experiments`）・`ai_usage_logs`（`ai-costs`）を
 * **同時に結合する**。どれか1つのモジュールに置くと、MODULE_RULES 1
 * （他モジュールのテーブルに直接アクセスしない）に反する。
 *
 * MODULE_RULES 3 が示す解消のしかたのうち「**上位へ寄せる**」に当たる。
 * TASKS も G-7 の主な変更先を `src/app/admin/` としている。
 *
 * ## SQLで書く理由
 *
 * SPEC 10.3 が「実験グループの作成・割当・比較を行う管理UIは実装しない。
 * **条件の記録は行い、集計はSQLで実施する**」と定めている。
 * ここは**読むだけ**で、実験グループの割当はSQLかシードで行う。
 *
 * ## 数えられないものを0で見せない
 *
 * `banner_clicks` と `page_views` は**測る経路が無い**（Q-032）。
 * 0として並べると「測ったが0だった」と読めるため、**画面に出さない。**
 */

/** 集計の単位 */
export type AggregateAxis = 'GENRE' | 'STRATEGY' | 'BLOG';

export interface AggregateRow {
  /** 並びの見出し（ジャンル名・戦略名・ブログ名） */
  label: string;
  /** その単位に属するブログ数 */
  blogs: number;
  impressions: number;
  searchClicks: number;
  affiliateClicks: number;
  aiReferrals: number;
  conversions: number;
  revenueYen: number;
  /** AI費用（USD）。`ai_usage_logs` から足す */
  aiCostUsd: number;
  /** 公開済みの記事数 */
  postedArticles: number;
}

interface RawRow {
  label: string | null;
  blogs: bigint;
  impressions: bigint | null;
  search_clicks: bigint | null;
  affiliate_clicks: bigint | null;
  ai_referrals: bigint | null;
  conversions: bigint | null;
  revenue_yen: bigint | null;
  ai_cost_usd: string | null;
  posted_articles: bigint;
}

function toNumber(value: bigint | null): number {
  return value === null ? 0 : Number(value);
}

function toRow(raw: RawRow): AggregateRow {
  return {
    // **未割当を「その他」でまとめない。** ジャンルや戦略が付いていない
    // ブログがあること自体が、運営が直すべき状態である
    label: raw.label ?? '（未設定）',
    blogs: Number(raw.blogs),
    impressions: toNumber(raw.impressions),
    searchClicks: toNumber(raw.search_clicks),
    affiliateClicks: toNumber(raw.affiliate_clicks),
    aiReferrals: toNumber(raw.ai_referrals),
    conversions: toNumber(raw.conversions),
    revenueYen: toNumber(raw.revenue_yen),
    aiCostUsd: raw.ai_cost_usd === null ? 0 : Number(raw.ai_cost_usd),
    postedArticles: Number(raw.posted_articles),
  };
}

/**
 * 軸ごとの結合先。
 *
 * **`metrics_daily` はブログ全体の行だけを足す**（`content_item_id IS NULL`）。
 * 記事ごとの行も足すと、**同じクリックを二重に数える**。
 */
const LABEL_SQL: Readonly<Record<AggregateAxis, string>> = {
  GENRE: 'g.name',
  STRATEGY: 'e.name',
  BLOG: 'b.name',
};

/**
 * 集計を取る。
 *
 * **ADMIN 専用。** 全利用者を横断して読むため、呼び出し側で
 * `requireAdmin` を通すこと（MODULE_RULES 5 の `...ForAdmin`）。
 */
export async function aggregateForAdmin(
  axis: AggregateAxis,
): Promise<AggregateRow[]> {
  const label = LABEL_SQL[axis];

  // **`metrics_daily` と `ai_usage_logs` を別々に集めてから結合する。**
  // 1つのクエリで両方を join すると、行数の掛け算で数が膨らむ
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `
    with blog_metrics as (
      select blog_id,
             sum(impressions)       as impressions,
             sum(search_clicks)     as search_clicks,
             sum(affiliate_clicks)  as affiliate_clicks,
             sum(ai_referrals)      as ai_referrals,
             sum(conversions)       as conversions,
             sum(revenue_yen)       as revenue_yen
      from metrics_daily
      -- **ブログ全体の行だけ。** 記事ごとの行も足すと二重に数える
      where content_item_id is null
      group by blog_id
    ),
    blog_costs as (
      select blog_id, sum(cost_usd) as ai_cost_usd
      from ai_usage_logs
      where blog_id is not null
      group by blog_id
    ),
    blog_posts as (
      select blog_id, count(*) as posted_articles
      from wordpress_posts
      group by blog_id
    )
    select ${label}                        as label,
           count(distinct b.id)            as blogs,
           sum(m.impressions)              as impressions,
           sum(m.search_clicks)            as search_clicks,
           sum(m.affiliate_clicks)         as affiliate_clicks,
           sum(m.ai_referrals)             as ai_referrals,
           sum(m.conversions)              as conversions,
           sum(m.revenue_yen)              as revenue_yen,
           sum(c.ai_cost_usd)              as ai_cost_usd,
           coalesce(sum(p.posted_articles), 0) as posted_articles
    from blogs b
    left join genres g            on g.id = b.genre_id
    left join experiment_groups e on e.id = b.experiment_group_id
    left join blog_metrics m      on m.blog_id = b.id
    left join blog_costs c        on c.blog_id = b.id
    left join blog_posts p        on p.blog_id = b.id
    -- **閉じたブログも数える。** 途中でやめたことも実験の結果である（H-4）
    group by ${label}
    order by ${label} nulls last
    `,
  );

  return rows.map(toRow);
}
