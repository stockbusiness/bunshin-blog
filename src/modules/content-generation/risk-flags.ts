/**
 * 禁止表現の検出とリスクフラグ（TASKS E-13、SPEC 9.6、DATA_MODEL 132）。
 *
 * ## プロンプトで禁じるだけでは足りない
 *
 * SPEC 9.6 が「AIは以下を生成してはならない」と挙げているものを、
 * **受信後にコードで探す**。E-10 の検査（リンク・PR表記・事実ID）と同じ考え。
 *
 * ## 落とすものと、人に見せるもの
 *
 * ここは**判定して印を付けるだけ**で、例外を投げない。
 * 承認へ送ってよいかは `hasBlockingRiskFlag` が決める。
 *
 * | severity | 意味 |
 * |---|---|
 * | `error` | **承認へ送らない。** 法令に触れるか、利用者が明示的に禁じた表現 |
 * | `warning` | 承認画面でリスク表示を付ける。人が見て判断する |
 * | `info` | 参考として残す |
 *
 * ## 語彙で拾える範囲しか拾えない
 *
 * 表現の言い換えは追えない。**取りこぼしを前提にする** — ここを通ったから
 * 安全なのではなく、**明らかなものを機械が先に落とす**ための仕組み。
 * 最後に見るのは承認者（SPEC 1.1 の「LINE承認型」）。
 *
 * DBも外部も触らない純粋な処理。
 */

import { PR_DISCLOSURE_PATTERNS } from './article';
import { factCheckAllowsApproval, type FactCheckStatus } from './fact-check';

/** リスクフラグ（DATA_MODEL 132 の形に合わせる） */
export type RiskFlag = {
  code: RiskFlagCode;
  severity: RiskSeverity;
  message: string;
  /** 本文のどこで見つかったか。承認画面が該当箇所を示すのに使う */
  excerpt: string;
};

export type RiskSeverity = 'info' | 'warning' | 'error';

export type RiskFlagCode =
  /** PR表記が無い（景表法のステマ規制。SPEC 9.6） */
  | 'PR_DISCLOSURE_MISSING'
  /** 利用者が禁じた表現（`persona.ngExpressions`） */
  | 'NG_EXPRESSION'
  /** 医療・投資などの高リスク助言（SPEC 9.6） */
  | 'HIGH_RISK_ADVICE'
  /** 効果の断定（SPEC 9.6） */
  | 'ASSERTIVE_CLAIM'
  /** 誇大表現（SPEC 9.6） */
  | 'EXAGGERATION'
  /** 根拠のないランキング（SPEC 9.6） */
  | 'RANKING_WITHOUT_BASIS'
  /** 架空の口コミ（SPEC 9.6） */
  | 'FABRICATED_REVIEW';

interface Detector {
  code: RiskFlagCode;
  severity: RiskSeverity;
  message: string;
  patterns: readonly RegExp[];
}

/**
 * **医療・投資の助言は `error`。** 薬機法・金商法に触れうる。
 * 「治る」「儲かる」は分身が言ってよい範囲の外にある。
 */
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /治(る|ります|ります|癒)/,
  /効果が(ある|あります|出ます)/,
  /副作用(は)?(ありません|なし)/,
  /(必ず|確実に)(儲か|稼げ|増え)/,
  /元本(が)?保証/,
  /損(は)?しません/,
  /病気が/,
];

/**
 * **効果の断定は `warning`。** 表現として強すぎるだけで、
 * 文脈によっては正しいこともある（「必ず本人確認が要ります」など）。
 * 落とさず人に見せる。
 */
const ASSERTIVE_PATTERNS: readonly RegExp[] = [
  /絶対に/,
  /必ず.{0,6}(でき|なり|得ら|叶)/,
  /100[%％]/,
  /誰でも(簡単に)?(稼|痩|治|でき)/,
  /間違いなく/,
  /確実に.{0,6}(でき|なり|得ら)/,
];

const EXAGGERATION_PATTERNS: readonly RegExp[] = [
  /(業界|日本|世界)(で)?(No\.?1|ナンバーワン|一)/i,
  /最(安|強|高峰)/,
  /劇的に/,
  /驚異の/,
  /唯一無二/,
];

const RANKING_PATTERNS: readonly RegExp[] = [
  /(第)?1位/,
  /ランキング/,
  /人気No\.?1/i,
];

const FABRICATED_REVIEW_PATTERNS: readonly RegExp[] = [
  /(利用者|購入者|ユーザー)の(声|口コミ)/,
  /口コミ(を)?(紹介|まとめ)/,
  /みんなの評判/,
];

const DETECTORS: readonly Detector[] = [
  {
    code: 'HIGH_RISK_ADVICE',
    severity: 'error',
    message: '医療・投資などの高リスクな助言が含まれています',
    patterns: HIGH_RISK_PATTERNS,
  },
  {
    code: 'ASSERTIVE_CLAIM',
    severity: 'warning',
    message: '効果を断定する表現が含まれています',
    patterns: ASSERTIVE_PATTERNS,
  },
  {
    code: 'EXAGGERATION',
    severity: 'warning',
    message: '誇大な表現が含まれています',
    patterns: EXAGGERATION_PATTERNS,
  },
  {
    code: 'RANKING_WITHOUT_BASIS',
    severity: 'warning',
    message: '順位付けの根拠を確かめてください',
    patterns: RANKING_PATTERNS,
  },
  {
    code: 'FABRICATED_REVIEW',
    severity: 'warning',
    message: '口コミの出どころを確かめてください',
    patterns: FABRICATED_REVIEW_PATTERNS,
  },
];

/** 前後をどれだけ切り出すか */
const EXCERPT_MARGIN = 20;

/**
 * タグを外して本文の文字列にする。
 *
 * **タグの中を検査しない。** `<a href="...ranking...">` の属性が
 * 「ランキング」として拾われると、本文に無いものを指摘することになる。
 */
export function stripTags(bodyHtml: string): string {
  return bodyHtml
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 見つかった位置の前後を切り出す */
function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_MARGIN);
  const end = Math.min(text.length, index + length + EXCERPT_MARGIN);

  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * 禁止表現を探す（SPEC 9.6）。
 *
 * **同じ code は1件にまとめる。** 同じ指摘が10件並ぶと、
 * 承認画面で他の指摘が埋もれる。
 */
export function detectProhibitedExpressions(bodyHtml: string): RiskFlag[] {
  const text = stripTags(bodyHtml);
  const flags: RiskFlag[] = [];

  for (const detector of DETECTORS) {
    for (const pattern of detector.patterns) {
      const match = pattern.exec(text);

      if (match === null) {
        continue;
      }

      flags.push({
        code: detector.code,
        severity: detector.severity,
        message: detector.message,
        excerpt: excerptAt(text, match.index, match[0].length),
      });

      break;
    }
  }

  return flags;
}

/**
 * 利用者が禁じた表現を探す（`persona.ngExpressions`、D-5）。
 *
 * **`error` にする。** 分身の設定として本人が明示的に挙げた語で、
 * 「文脈によっては良い」の余地が無い。
 */
export function detectNgExpressions(params: {
  bodyHtml: string;
  ngExpressions: readonly string[];
}): RiskFlag[] {
  const text = stripTags(params.bodyHtml);
  const flags: RiskFlag[] = [];

  for (const expression of params.ngExpressions) {
    const needle = expression.trim();

    if (needle === '') {
      continue;
    }

    const index = text.indexOf(needle);

    if (index < 0) {
      continue;
    }

    flags.push({
      code: 'NG_EXPRESSION',
      severity: 'error',
      message: `使わないと決めた表現が含まれています（${needle}）`,
      excerpt: excerptAt(text, index, needle.length),
    });
  }

  return flags;
}

/**
 * PR表記の欠落を探す（SPEC 9.6、景表法のステマ規制）。
 *
 * **`error`。** E-10 は生成の直後に例外で落とすが、ここでも見る —
 * 修正依頼（F-6）で人が本文を書き換えたあと、承認へ進む前に
 * もう一度通るのはこちら。
 */
export function detectPrDisclosureMissing(params: {
  bodyHtml: string;
  hasAffiliateLink: boolean;
}): RiskFlag[] {
  if (!params.hasAffiliateLink) {
    return [];
  }

  if (PR_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(params.bodyHtml))) {
    return [];
  }

  return [
    {
      code: 'PR_DISCLOSURE_MISSING',
      severity: 'error',
      message: '広告リンクを含む記事にPR表記がありません',
      excerpt: '',
    },
  ];
}

/**
 * 記事のリスクフラグをすべて集める（TASKS E-13）。
 *
 * 完了条件は「**PR表記欠落と断定表現を検出**」。
 */
export function detectRiskFlags(params: {
  bodyHtml: string;
  hasAffiliateLink: boolean;
  ngExpressions: readonly string[];
}): RiskFlag[] {
  return [
    ...detectPrDisclosureMissing({
      bodyHtml: params.bodyHtml,
      hasAffiliateLink: params.hasAffiliateLink,
    }),
    ...detectNgExpressions({
      bodyHtml: params.bodyHtml,
      ngExpressions: params.ngExpressions,
    }),
    ...detectProhibitedExpressions(params.bodyHtml),
  ];
}

/**
 * 承認へ送るのを止めるフラグがあるか。
 *
 * **`error` だけが止める。** `warning` を止めると、
 * 「ランキング」の一語で記事が進まなくなる。**判断は承認者に残す**
 * （SPEC 1.1「LINE承認型」）。
 */
export function hasBlockingRiskFlag(flags: readonly RiskFlag[]): boolean {
  return flags.some((flag) => flag.severity === 'error');
}

/**
 * 承認依頼へ送ってよいかの**唯一の判定**（SPEC 9.7、TASKS E-13）。
 *
 * **事実チェックとリスクフラグの両方を見る。** 片方だけを見る関数を
 * 呼び出し側から使えるようにすると、**いつか片方だけで通す経路ができる**。
 *
 * `FAILED` / `NOT_CHECKED` の記事、または `error` のフラグがある記事は
 * 送らない。
 */
export function canSendToApproval(params: {
  factCheckStatus: FactCheckStatus | 'NOT_CHECKED';
  riskFlags: readonly RiskFlag[];
}): boolean {
  return (
    factCheckAllowsApproval(params.factCheckStatus) &&
    !hasBlockingRiskFlag(params.riskFlags)
  );
}
