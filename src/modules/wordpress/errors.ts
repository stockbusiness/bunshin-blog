import { AppError } from '@/lib/errors';

/**
 * wordpress モジュールのエラーコード（TASKS C-1）。
 *
 * 接続テストの権限別コード（SPEC 7.2 の7項目）は C-2 で追加する。
 * ここには「保存」に関わるものだけを置く。
 */
export const WORDPRESS_ERROR_CODES = {
  /** `site_url` の形式が受け付けられない */
  invalidSiteUrl: 'WORDPRESS_INVALID_SITE_URL',
  /** 接続後に別サイトへ変更しようとした（OPEN_QUESTIONS Q-007） */
  siteUrlImmutable: 'WORDPRESS_SITE_URL_IMMUTABLE',
  /** まだ接続していない、または切断済み */
  notConnected: 'WORDPRESS_NOT_CONNECTED',
  /** 保存済みの認証情報を復号できない（鍵の入れ替えなど） */
  credentialsUnreadable: 'WORDPRESS_CREDENTIALS_UNREADABLE',
} as const;

export type WordpressErrorCode =
  (typeof WORDPRESS_ERROR_CODES)[keyof typeof WORDPRESS_ERROR_CODES];

/**
 * `site_url` の形式が不正であることを表す。
 *
 * **理由はモニターへ返す。** 認証と違い、ここは入力ミスの訂正が目的であり、
 * 「httpsで指定してください」と伝えないと直しようがない。
 */
export function invalidSiteUrlError(reason: string): AppError {
  return new AppError(
    WORDPRESS_ERROR_CODES.invalidSiteUrl,
    422,
    `サイトURLを確認してください：${reason}`,
  );
}

/**
 * 接続先の変更が拒否されたことを表す（Q-007）。
 *
 * **保存済みの `site_url` をメッセージへ含めない。** 他人のブログIDを
 * 当てられた場合に接続先を教えることになる（所有権エラーは 404 で
 * 弾かれるが、メッセージに秘密でない情報でも足さない方針を通す）。
 */
export function siteUrlImmutableError(): AppError {
  return new AppError(
    WORDPRESS_ERROR_CODES.siteUrlImmutable,
    409,
    '接続先のサイトは後から変更できません。認証情報の更新は同じURLのまま行えます',
  );
}

/** まだ接続していないことを表す */
export function notConnectedError(): AppError {
  return new AppError(
    WORDPRESS_ERROR_CODES.notConnected,
    404,
    'WordPressに接続されていません',
  );
}

/**
 * 保存済みの認証情報を復号できないことを表す。
 *
 * 鍵の入れ替え・DBの書き換えで起きる。**復号できない理由をクライアントへ
 * 返さない**（`DecryptionError` の方針と揃える）。運用側はログで気づく。
 */
export function credentialsUnreadableError(cause?: unknown): AppError {
  return new AppError(
    WORDPRESS_ERROR_CODES.credentialsUnreadable,
    500,
    '保存された認証情報を読み出せませんでした。接続し直してください',
    cause === undefined ? {} : { cause },
  );
}

/**
 * 接続テストの検査項目（SPEC 7.2 の7項目）。
 *
 * **項目ごとに別のコードを返す**（TASKS C-2 の完了条件）。
 * 「接続できません」だけでは、モニターが何を直せばよいか分からない。
 */
export const WORDPRESS_TEST_ERROR_CODES = {
  /** 保存済みの `site_url` が形式として通らない（C-1 より前に入った行） */
  invalidUrl: 'WORDPRESS_TEST_INVALID_URL',
  /** REST API へ到達できない（DNS・TLS・タイムアウト・到達禁止アドレス） */
  unreachable: 'WORDPRESS_TEST_UNREACHABLE',
  /** 応答はあるが WordPress の REST API ではない */
  notWordpress: 'WORDPRESS_TEST_NOT_WORDPRESS',
  /** 認証に失敗した（ユーザー名またはアプリケーションパスワード） */
  authFailed: 'WORDPRESS_TEST_AUTH_FAILED',
  /** 投稿一覧を取得できない */
  cannotListPosts: 'WORDPRESS_TEST_CANNOT_LIST_POSTS',
  /** 下書きを作成する権限が無い */
  cannotCreatePosts: 'WORDPRESS_TEST_CANNOT_CREATE_POSTS',
  /** 投稿を編集する権限が無い */
  cannotEditPosts: 'WORDPRESS_TEST_CANNOT_EDIT_POSTS',
  /** メディアをアップロードする権限が無い */
  cannotUploadMedia: 'WORDPRESS_TEST_CANNOT_UPLOAD_MEDIA',
  /** テスト投稿を消せなかった。接続自体は成功している */
  cleanupFailed: 'WORDPRESS_TEST_CLEANUP_FAILED',
} as const;

export type WordpressTestErrorCode =
  (typeof WORDPRESS_TEST_ERROR_CODES)[keyof typeof WORDPRESS_TEST_ERROR_CODES];
