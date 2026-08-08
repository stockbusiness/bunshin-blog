/**
 * アフィリエイトリンクの組み立て（TASKS D-1、OPEN_QUESTIONS Q-001・Q-014）。
 *
 * ## ここが唯一の組み立て場所
 *
 * **リンクを作るのはこのファイルだけ。** 記事生成（E-10）も、バナー（D-3）も、
 * リダイレクタ（D-8）も、ここを通す。
 *
 * 理由は Q-001 が定めている。**ASPによって、別ドメインのリダイレクタ経由の
 * 掲載を許すところと許さないところがある。** 方式を1つに決められないので、
 * 案件ごとに `link_mode` を持つ。
 *
 * 判断をここに閉じておけば、**後からASPの規約が変わっても影響するのは
 * 以後に生成される記事だけ**で、公開済み記事の貼り替えは起きない。
 * SPEC 20.1 が Q-001 を Phase A 着手前としたのは、まさにこの手戻りを
 * 避けるためだった。
 *
 * ## 2つのURLを返す
 *
 * | | 記事本文へ埋める（`href`） | 利用者の飛び先（`destinationUrl`） |
 * |---|---|---|
 * | `REDIRECT` | `<APP_BASE_URL>/go/<code>` | サブID付きのアフィリエイトURL |
 * | `DIRECT` | サブID付きのアフィリエイトURL | 同じ |
 *
 * `REDIRECT` では `destinationUrl` を `affiliate_links.destination_url` へ
 * 保存する（D-8）。**リダイレクタを経由してもサブIDは落とさない。**
 *
 * ## サブIDは方式によらず付ける
 *
 * リダイレクタは**クリック**を数え、サブIDは**成果**を紐づける。役割が違う
 * ため、`REDIRECT` の案件にも付ける（Q-001）。
 *
 * ただし**パラメータ名はASPごとに違う**（`sub` `s1` `argument` など）。
 * `sub_id_param` が `NULL` の案件には付けない（Q-014）。ASPの情報がゼロでも
 * 案件は登録でき、サブIDが付かないだけになる。
 */

import type { LinkMode } from './types';
import {
  invalidUrlError,
  missingRedirectCodeError,
  redirectNotConfiguredError,
} from './errors';

/** サブIDの `<slot>` と `<contentItemId>` を繋ぐ文字 */
export const SUB_ID_SEPARATOR = '-';

/** リダイレクタのパス（D-8 の `src/app/go/`） */
export const REDIRECT_PATH = '/go';

/** 組み立てに要る案件の情報だけを取る（行そのものを渡さない） */
export interface LinkableOffer {
  affiliateUrl: string;
  linkMode: LinkMode;
  /** `null` ならサブIDを付けない（Q-014） */
  subIdParam: string | null;
}

export interface AffiliateLinkTarget {
  /** 記事本文へ埋めるURL */
  href: string;
  /**
   * 利用者が最終的に着くURL（サブID付き）。
   *
   * `REDIRECT` では `affiliate_links.destination_url` に保存する。
   */
  destinationUrl: string;
  linkMode: LinkMode;
  /** 付けたサブID。付けなかったら `null` */
  subId: string | null;
}

/**
 * サブIDの値を作る（Q-001）。
 *
 * 形は `<slot>-<contentItemId>`。**ブログのスロット番号を先頭に置く**ので、
 * ASPの管理画面で見たときにどのブログの成果かがすぐ分かる。
 */
export function buildSubId(params: {
  slotNumber: number;
  contentItemId: string;
}): string {
  return `${params.slotNumber}${SUB_ID_SEPARATOR}${params.contentItemId}`;
}

/**
 * アフィリエイトURLへサブIDを足す。
 *
 * **同じ名前のパラメータが既にあれば置き換える。** ASPが発行したURLに
 * 初期値が入っていることがあり、2つ付けると解釈がASP任せになる。
 *
 * @throws {AppError} URLとして解釈できない
 */
export function appendSubId(
  affiliateUrl: string,
  subIdParam: string | null,
  subId: string,
): { url: string; subId: string | null } {
  if (subIdParam === null || subIdParam === '') {
    return { url: affiliateUrl, subId: null };
  }

  let url: URL;
  try {
    url = new URL(affiliateUrl);
  } catch {
    throw invalidUrlError('アフィリエイトURL', 'URLとして解釈できません');
  }

  url.searchParams.set(subIdParam, subId);

  return { url: url.toString(), subId };
}

export interface BuildAffiliateLinkOptions {
  offer: LinkableOffer;
  /** ブログのスロット番号（1〜3） */
  slotNumber: number;
  contentItemId: string;
  /**
   * リダイレクタのコード（`affiliate_links.code`）。
   *
   * `REDIRECT` の案件では必須。発行と保存は D-8 の担当。
   */
  redirectCode?: string | undefined;
  /** 差し替え用。既定は `APP_BASE_URL` */
  baseUrl?: string | undefined;
}

/**
 * 記事へ埋めるリンクを組み立てる。
 *
 * **`link_mode` を見るのはここだけ。** 呼び出し側に分岐を書かせない。
 *
 * @throws {AppError} URLが壊れている・`REDIRECT` なのにコードが無い・
 *   リダイレクタの公開URLが未設定
 */
export function buildAffiliateLink(
  options: BuildAffiliateLinkOptions,
): AffiliateLinkTarget {
  const { offer } = options;

  const { url: destinationUrl, subId } = appendSubId(
    offer.affiliateUrl,
    offer.subIdParam,
    buildSubId({
      slotNumber: options.slotNumber,
      contentItemId: options.contentItemId,
    }),
  );

  if (offer.linkMode === 'DIRECT') {
    return { href: destinationUrl, destinationUrl, linkMode: 'DIRECT', subId };
  }

  const code = options.redirectCode;
  if (code === undefined || code === '') {
    throw missingRedirectCodeError();
  }

  return {
    href: buildRedirectUrl(code, options.baseUrl),
    destinationUrl,
    linkMode: 'REDIRECT',
    subId,
  };
}

/**
 * リダイレクタのURLを作る。
 *
 * **`APP_BASE_URL` から作る。** リクエストの `Host` を使わない（B-10 と
 * 同じ方針）。`Host` は詐称でき、記事本文へ埋まると後から直せない。
 */
export function buildRedirectUrl(code: string, baseUrl?: string): string {
  const base = baseUrl ?? process.env.APP_BASE_URL ?? '';
  if (base === '') {
    throw redirectNotConfiguredError();
  }

  return `${base.replace(/\/+$/, '')}${REDIRECT_PATH}/${encodeURIComponent(code)}`;
}
