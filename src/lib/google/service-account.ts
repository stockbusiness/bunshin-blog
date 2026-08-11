/**
 * サービスアカウントでアクセストークンを取る（TASKS G-1、OPEN_QUESTIONS Q-030）。
 *
 * ## なぜ OAuth の同意画面を使わないか
 *
 * `webmasters.readonly` は Google の**機密スコープ**で、審査を通さない場合の
 * 公開状態は「テスト」になる。**その状態のリフレッシュトークンは7日で失効する。**
 * 3か月の実験（SPEC 1.2）で毎週つなぎ直させることになり、
 * 日次の取得ジョブ（G-2）が週明けに落ちてデータに穴が空く。
 *
 * サービスアカウントの鍵は失効しない。モニターは Search Console の
 * 「ユーザーと権限」でこちらのアドレスに権限を渡すだけで済む。
 *
 * ## SDKを入れない
 *
 * `googleapis` は大きい。ここでやるのは**JWTを1つ署名して1回POSTする**だけで、
 * `node:crypto` で足りる（`line/messaging.ts`・`mailer/resend.ts` と同じ判断）。
 */

import { createSign } from 'node:crypto';
import { Secret } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import {
  GoogleAuthError,
  GoogleServiceAccountInvalidError,
  type GoogleAccessToken,
  type GoogleServiceAccount,
} from './types';

/** サービスアカウントのJWTを引き換える先 */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Search Console の読み取りスコープ。
 *
 * **書き込みのスコープを要求しない。** こちらがするのは取得だけで、
 * 万一鍵が漏れてもモニターのプロパティ設定を変えられないほうがよい。
 */
export const SEARCH_CONSOLE_SCOPE =
  'https://www.googleapis.com/auth/webmasters.readonly';

/** JWT の有効期間。Google の上限は1時間 */
const ASSERTION_LIFETIME_SECONDS = 3600;

/**
 * 期限のどれだけ手前で取り直すか。
 *
 * **ぎりぎりまで使わない。** 通信の途中で切れると、失敗の原因が
 * 「権限が無い」と見分けにくくなる。
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * 鍵のJSONを読む。
 *
 * **鍵は1つの値として保存する**（`GOOGLE_SERVICE_ACCOUNT_KEY`）。
 * `client_email` と `private_key` を別々の設定にすると、
 * **片方だけ差し替えられて食い違う**。Google が配るのもこのJSONそのもの。
 *
 * @throws {GoogleServiceAccountInvalidError} 形が違う
 */
export function parseServiceAccountKey(raw: string): GoogleServiceAccount {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // **元の例外を持たない。** 解析エラーの本文には鍵の一部が載りうる
    throw new GoogleServiceAccountInvalidError('JSONとして読めません');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new GoogleServiceAccountInvalidError('JSONの形が違います');
  }

  const record = parsed as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKey = record['private_key'];

  if (typeof clientEmail !== 'string' || clientEmail.trim() === '') {
    throw new GoogleServiceAccountInvalidError('client_email がありません');
  }

  if (typeof privateKey !== 'string' || privateKey.trim() === '') {
    throw new GoogleServiceAccountInvalidError('private_key がありません');
  }

  // **PEMの形だけ確かめる。** ここで弾けば、署名の時点ではなく
  // 保存の時点で「鍵が壊れている」と分かる
  if (!privateKey.includes('-----BEGIN')) {
    throw new GoogleServiceAccountInvalidError('private_key の形が違います');
  }

  return {
    clientEmail: clientEmail.trim(),
    privateKey: new Secret(privateKey),
  };
}

/**
 * JWT を署名する。
 *
 * Google のサービスアカウント認証は `RS256` に限られる。
 */
export function signAssertion(params: {
  account: GoogleServiceAccount;
  scope: string;
  now: Date;
}): string {
  const issuedAt = Math.floor(params.now.getTime() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: params.account.clientEmail,
      scope: params.scope,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);

  const signature = signer.sign(params.account.privateKey.expose());

  return `${header}.${claims}.${base64url(signature)}`;
}

export interface FetchAccessTokenOptions {
  fetchFn?: typeof fetch;
  endpoint?: string;
  now?: Date;
  scope?: string;
}

/**
 * アクセストークンを取る。
 *
 * @throws {GoogleAuthError} 取れなかった
 */
export async function fetchAccessToken(
  account: GoogleServiceAccount,
  options: FetchAccessTokenOptions = {},
): Promise<GoogleAccessToken> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? GOOGLE_TOKEN_ENDPOINT;
  const now = options.now ?? new Date();
  const scope = options.scope ?? SEARCH_CONSOLE_SCOPE;

  const assertion = signAssertion({ account, scope, now });

  let response: Response;

  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
  } catch {
    // **元の例外を持たない。** 本文にアサーション（署名済みの鍵の証明）が載りうる
    throw new GoogleAuthError('Google の認証サーバーへ届きませんでした');
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error('Google のトークン取得が失敗した', {
      status: response.status,
      detail,
    });

    throw new GoogleAuthError('Google の認証に失敗しました');
  }

  const body: unknown = await response.json().catch(() => null);

  if (typeof body !== 'object' || body === null) {
    throw new GoogleAuthError('Google の応答を読めませんでした');
  }

  const record = body as Record<string, unknown>;
  const token = record['access_token'];
  const expiresIn = record['expires_in'];

  if (typeof token !== 'string' || token === '') {
    throw new GoogleAuthError('アクセストークンが返りませんでした');
  }

  // **期限が返らなければ短く見積もる。** 長く見積もると、
  // 失効したトークンを使い続けて原因の分かりにくい失敗になる
  const lifetimeSeconds =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : 300;

  return {
    token: new Secret(token),
    expiresAt: new Date(now.getTime() + lifetimeSeconds * 1000),
  };
}

/** 期限が近いか。**手前で取り直す** */
export function isTokenExpired(token: GoogleAccessToken, now: Date): boolean {
  return token.expiresAt.getTime() - now.getTime() <= TOKEN_EXPIRY_MARGIN_MS;
}
