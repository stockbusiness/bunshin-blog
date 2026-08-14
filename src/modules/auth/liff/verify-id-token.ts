import { z } from 'zod';
import { logger as defaultLogger, type Logger } from '@/lib/logger';
import { getRuntimeEnv } from '@/modules/settings';
import {
  invalidIdTokenError,
  liffChannelNotConfiguredError,
  verificationUnavailableError,
} from '../errors';

/**
 * LIFF の IDトークン検証（TASKS B-1）。
 *
 * SPEC 3.2 / 13.1:
 * - LIFFから取得したIDトークンをサーバーで検証する
 * - `line_user_id` はトークンの `sub` からのみ取り出す
 * - **クライアントが送信したユーザーIDを信用しない**
 *
 * 検証は LINE の検証エンドポイントに委ねる（SPEC 13.1「LINEサーバーで検証」）。
 * そのうえで `iss` / `aud` / `exp` を**こちら側でも再確認する**。
 * 検証結果の解釈を相手側の実装だけに預けない。
 */

/** LINE の IDトークン検証エンドポイント */
export const LINE_VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify';

/** IDトークンの発行者。LINE Login v2.1 では固定 */
export const LINE_ISSUER = 'https://access.line.me';

/**
 * 期限判定の許容誤差（秒）。
 * サーバー間の時刻ずれで正当なトークンを弾かないための最小限の余裕。
 */
const CLOCK_SKEW_SECONDS = 60;

/** 検証を通ったIDトークンの中身 */
export interface LiffIdTokenClaims {
  /** `users.line_user_id` に対応する。トークンの `sub` のみを源とする */
  lineUserId: string;
  /** 検証に使ったチャネルID */
  channelId: string;
  issuedAt: Date;
  expiresAt: Date;
  displayName: string | undefined;
  pictureUrl: string | undefined;
  email: string | undefined;
}

/** LINE の検証エンドポイントが返すペイロード */
const verifyResponseSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
  name: z.string().optional(),
  picture: z.string().optional(),
  email: z.string().optional(),
});

export interface VerifyLiffIdTokenOptions {
  /**
   * 期待するチャネルID。省くと**管理画面の設定**（`LINE_LOGIN_CHANNEL_ID`）
   * から読む（Q-046）。
   */
  channelId?: string;
  /** テストから差し替えるための `fetch` */
  fetchImpl?: typeof fetch;
  /** テストから差し替えるための現在時刻 */
  now?: () => Date;
  logger?: Logger;
}

/**
 * チャネルIDを決める。
 *
 * **管理画面 → 環境変数の順**（`getRuntimeEnv`）。DBを先にするのは
 * 「画面で設定したのに効かない」が最も原因を追いにくいため（H-7）。
 *
 * **未設定を「不正なトークン」として扱わない**（Q-046）。混ぜると、
 * こちらの設定漏れが**利用者のトークンの問題に見える。**
 */
async function resolveChannelId(
  options: VerifyLiffIdTokenOptions,
): Promise<string> {
  if (options.channelId !== undefined) {
    return options.channelId;
  }

  const configured = (await getRuntimeEnv())['LINE_LOGIN_CHANNEL_ID'];

  if (configured === undefined || configured.trim() === '') {
    throw liffChannelNotConfiguredError();
  }

  return configured;
}

/**
 * LIFF の IDトークンを検証し、`line_user_id` を含む中身を返す。
 *
 * 改竄されたトークン・期限切れ・別チャネル向けのトークンは全て拒否する。
 *
 * @throws {AppError} 検証に失敗した場合（401）。理由はログにのみ残す
 * @throws {AppError} LINEへ到達できなかった場合（503）
 * @throws {AppError} チャネルIDが未設定の場合（503・Q-046）
 */
export async function verifyLiffIdToken(
  idToken: string,
  options: VerifyLiffIdTokenOptions = {},
): Promise<LiffIdTokenClaims> {
  const log = options.logger ?? defaultLogger;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  if (typeof idToken !== 'string' || idToken.trim() === '') {
    throw invalidIdTokenError('IDトークンが空');
  }

  const channelId = await resolveChannelId(options);

  let response: Response;
  try {
    response = await fetchImpl(LINE_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: channelId,
      }).toString(),
    });
  } catch (error) {
    log.error('LINEの検証エンドポイントへ到達できない', { cause: error });
    throw verificationUnavailableError(error);
  }

  if (response.status >= 500) {
    log.error('LINEの検証エンドポイントが5xxを返した', {
      status: response.status,
    });
    throw verificationUnavailableError({ status: response.status });
  }

  // 署名不正・期限切れ・チャネル不一致はいずれも 400 で返る
  if (!response.ok) {
    log.warn('IDトークンがLINEの検証を通らなかった', {
      status: response.status,
    });
    throw invalidIdTokenError(`LINEが ${response.status} を返した`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw invalidIdTokenError('検証結果がJSONとして読めない', error);
  }

  const parsed = verifyResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidIdTokenError('検証結果に必要な項目が無い');
  }

  const claims = parsed.data;

  // ここから先はLINE側の検証を信用せず、こちらでも確認する
  if (claims.iss !== LINE_ISSUER) {
    throw invalidIdTokenError('iss が LINE のものではない');
  }

  if (claims.aud !== channelId) {
    // 別チャネル向けに正当に発行されたトークンの使い回しを防ぐ
    throw invalidIdTokenError('aud が期待するチャネルIDと一致しない');
  }

  const nowSeconds = Math.floor(now().getTime() / 1000);
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw invalidIdTokenError('exp が過去');
  }

  if (claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw invalidIdTokenError('iat が未来');
  }

  return {
    lineUserId: claims.sub,
    channelId,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000),
    displayName: claims.name,
    pictureUrl: claims.picture,
    email: claims.email,
  };
}
