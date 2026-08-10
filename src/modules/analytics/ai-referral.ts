/**
 * AI検索サービス経由の流入の判別（TASKS G-4、SPEC 11.4）。
 *
 * 完了条件は「**対象ドメインが設定ファイルで追加できる**」。
 *
 * ## 設定ファイルに置く理由
 *
 * AI検索は増えるし、名前も変わる。**新しいサービスが出るたびに
 * マイグレーションや環境変数の追加を要求すると、追いつけない。**
 * ここは値の一覧であって、判断ではない。
 *
 * ## 完全な数にならない
 *
 * > referrerが欠落する場合があるため、**完全値として扱わない**
 * > （SPEC 11.4）
 *
 * `Referer` は付かないことがある。**取れなかったものを「AI経由でない」
 * に倒している**ので、この数は必ず実際より少ない。
 * 表記も「判別可能なAIサービス経由流入数」とする（SPEC 11.4）。
 *
 * ## 後から数え直せる
 *
 * `link_clicks.referrer_host` を残してあるので（D-8）、対象ドメインを
 * 足したあとに**過去のクリックも数え直せる**。判別の結果を
 * `is_ai_referral` に持つのは集計を速くするためで、元の値ではない。
 *
 * DBも外部も触らない純粋な処理。
 */

/**
 * AI検索サービスのホスト名。
 *
 * **末尾一致で判定する。** `chatgpt.com` と `www.chatgpt.com`、
 * 地域ごとのサブドメインを1つずつ書き足したくない。
 *
 * ここに無いサービスは数えられない。**足すのはこの配列だけ**で、
 * 判別の処理は変えなくてよい。
 */
export const AI_REFERRAL_DOMAINS: readonly string[] = [
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'perplexity.ai',
  'gemini.google.com',
  'bard.google.com',
  'copilot.microsoft.com',
  'claude.ai',
  'you.com',
  'phind.com',
  'felo.ai',
  'genspark.ai',
];

/**
 * ホスト名がドメインに属するか。
 *
 * **末尾一致だが、区切りを確かめる。** 単純な `endsWith` だと
 * `notchatgpt.com` が `chatgpt.com` に一致してしまう。
 */
export function matchesDomain(host: string, domain: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '');
  const normalizedDomain = domain.trim().toLowerCase().replace(/^\./, '');

  if (normalizedHost === normalizedDomain) {
    return true;
  }

  return normalizedHost.endsWith(`.${normalizedDomain}`);
}

/**
 * AI検索サービス経由かどうか。
 *
 * **`null` は `false`。** `Referer` が無いのは異常ではなく、
 * 「AI経由だと判別できなかった」だけ（SPEC 11.4）。
 */
export function isAiReferralHost(
  host: string | null | undefined,
  domains: readonly string[] = AI_REFERRAL_DOMAINS,
): boolean {
  if (host === null || host === undefined || host.trim() === '') {
    return false;
  }

  return domains.some((domain) => matchesDomain(host, domain));
}

/**
 * 環境変数で対象ドメインを足す。
 *
 * **消せない。足すだけ。** 誤って空にすると、判別が全て `false` になり、
 * 「AI経由の流入が無い」と読めてしまう。既定を上書きさせない。
 *
 * 区切りはカンマ。空白は落とす。
 */
export function resolveAiReferralDomains(
  source: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const extra = (source['AI_REFERRAL_EXTRA_DOMAINS'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');

  return [...new Set([...AI_REFERRAL_DOMAINS, ...extra])];
}
