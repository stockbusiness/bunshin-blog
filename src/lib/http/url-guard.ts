/**
 * 取得先URLの検証と名前解決（TASKS C-7、SPEC 14.3）。
 *
 * **転送のたびに同じ検証をやり直す。** 最初のURLだけを見て転送先を
 * 素通しすると、公開サイトから `http://169.254.169.254/` へ飛ばすだけで
 * 対策が無効になる。
 */

import { classifyAddress } from './address';
import { HTTP_ERROR_CODES, HttpFetchError } from './errors';

/** 名前解決の結果。差し替えられるようにインターフェースで受ける */
export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** 取得を認めるスキーム（SPEC 14.3「http/httpsのみ」） */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * URLとして取得してよい形かを確かめる。
 *
 * ここでは**名前解決をしない**。形式の判定と到達判定を分けておくと、
 * 転送先の再検証で同じ関数を使い回せる。
 *
 * @throws {HttpFetchError} 形式が不正な場合
 */
export function assertFetchableUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.invalidUrl,
      'URLとして読み取れません',
      { detail: String(value) },
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.invalidUrl,
      'http または https のURLを指定してください',
      { detail: url.protocol },
    );
  }

  // `https://user:pass@internal/` のような形で、資格情報を外へ持ち出させない
  if (url.username !== '' || url.password !== '') {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.invalidUrl,
      'URLにユーザー名やパスワードを含めないでください',
      { detail: url.hostname },
    );
  }

  if (url.hostname === '') {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.invalidUrl,
      'ホスト名がありません',
      { detail: url.href },
    );
  }

  return url;
}

/**
 * ホスト名を解決し、**全ての結果**が到達可能かを確かめる。
 *
 * 1件でも塞ぐべきアドレスが混ざっていれば拒否する。「先頭だけ見て通す」と、
 * 公開IPと内部IPの両方を返すレコードで内部側へ繋がりうる。
 *
 * 戻り値は接続先として固定するアドレス。**ホスト名で繋ぎ直させない。**
 * 判定と接続の間にDNSの応答が変わると（DNSリバインディング）、
 * 判定を通ったあとで内部アドレスへ繋がる。
 *
 * @throws {HttpFetchError} 解決できない、または到達を認めないアドレスの場合
 */
export async function resolveAllowedAddress(
  hostname: string,
  lookup: HostLookup,
): Promise<ResolvedAddress> {
  // 角括弧つきのIPv6リテラル（[::1]）はそのまま解決へ渡さない
  const host = hostname.replace(/^\[|\]$/g, '');

  let resolved: ResolvedAddress[];
  try {
    resolved = await lookup(host);
  } catch (error) {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.dnsFailed,
      'ホスト名を解決できませんでした',
      { detail: host, cause: error },
    );
  }

  if (resolved.length === 0) {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.dnsFailed,
      'ホスト名を解決できませんでした',
      { detail: host },
    );
  }

  for (const entry of resolved) {
    const verdict = classifyAddress(entry.address);
    if (verdict.blocked) {
      throw new HttpFetchError(
        HTTP_ERROR_CODES.blockedAddress,
        '到達できないアドレスです',
        {
          detail: `${host} -> ${entry.address}（${verdict.reason ?? '不明'}）`,
        },
      );
    }
  }

  return resolved[0] as ResolvedAddress;
}

/**
 * 転送先のURLを組み立てる。
 *
 * 相対URLを絶対化したうえで、**最初と同じ形式検証を通す**。
 * 到達判定（名前解決）は呼び出し側が改めて行う。
 *
 * @throws {HttpFetchError} 転送先が取得を認められない形式の場合
 */
export function resolveRedirectTarget(current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new HttpFetchError(
      HTTP_ERROR_CODES.invalidUrl,
      '転送先のURLを読み取れません',
      { detail: location },
    );
  }

  return assertFetchableUrl(next);
}
