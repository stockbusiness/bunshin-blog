/**
 * wordpress モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `wordpress_connections` テーブルを触ってよいのはこのモジュールだけ。
 *
 * **暗号文の列と復号値を公開しない**（SPEC 5.4・14.2）。
 * 外へ出るのは `AppWordpressConnection` と、`Secret` に包まれた
 * `WordpressCredentials` のみ。
 *
 * **IDだけで接続を引く関数を公開しない**（SPEC 14.1）。
 * 全ての取得・更新は `userId` を伴う。
 */

export {
  connectWordpressForUser,
  disconnectWordpressForUser,
  findWordpressConnectionForUser,
  readWordpressCredentialsForUser,
  testWordpressConnectionForUser,
  publishDraftForUser,
  syncWordpressPostForUser,
  findWordpressPostForUser,
} from './repository';

export {
  syncPost,
  fetchRemotePost,
  isUserEdited,
  type RemotePostState,
  type SyncPostResult,
} from './sync';

export {
  publishDraft,
  contentHash,
  toPostStatus,
  POST_TITLE_MAX_LENGTH,
  POST_CONTENT_MAX_BYTES,
  type PublishDraftInput,
  type PublishDraftResult,
  type ExistingPost,
} from './draft';

export {
  runConnectionTest,
  CONNECTION_CHECK_IDS,
  TEST_POST_TITLE,
  type ConnectionCheck,
  type ConnectionCheckId,
  type ConnectionCheckStatus,
  type ConnectionTestResult,
} from './connection-test';

export {
  createWordpressClient,
  readWordpressError,
  allowsMethod,
  WORDPRESS_TIMEOUT_MS,
  WORDPRESS_MAX_BYTES,
  type WordpressClient,
  type WordpressClientOptions,
  type WordpressApiResponse,
  type WordpressRequest,
  type WordpressErrorBody,
} from './client';

export {
  normalizeSiteUrl,
  deriveApiBaseUrl,
  isSameSite,
  assertSiteUrlUnchanged,
  SITE_URL_MAX_LENGTH,
} from './site-url';

/**
 * 差し込み版。DBと暗号化を渡して使う。
 *
 * 通常は上の `...ForUser` を使う。こちらはテストと、
 * 別のDB実装を渡す必要が出た場合のための入口。
 */
export {
  connectWordpress,
  disconnectWordpress,
  readWordpressCredentials,
  toAppConnection,
  credentialAad,
  WP_USERNAME_MAX_LENGTH,
  APP_PASSWORD_MAX_LENGTH,
} from './service';

export type {
  WordpressConnectionDb,
  WordpressSecretCipher,
  WordpressDeps,
  StoredWordpressConnection,
  WordpressConnectionWrite,
} from './service';

export {
  WORDPRESS_ERROR_CODES,
  invalidSiteUrlError,
  siteUrlImmutableError,
  notConnectedError,
  credentialsUnreadableError,
  WORDPRESS_TEST_ERROR_CODES,
  WORDPRESS_POST_ERROR_CODES,
  WORDPRESS_SYNC_ERROR_CODES,
  postFailedError,
  publishedPostNotEditableError,
  userEditedNotOverwritableError,
  syncFailedError,
  type WordpressErrorCode,
  type WordpressTestErrorCode,
  type WordpressPostErrorCode,
  type WordpressSyncErrorCode,
} from './errors';

export type {
  AppWordpressConnection,
  AppWordpressPost,
  WordpressConnectionStatus,
  WordpressPostStatus,
  ConnectWordpressInput,
  WordpressCredentials,
} from './types';

export {
  createAuthorizeState,
  verifyAuthorizeState,
  buildAuthorizeUrl,
  matchesRequestedSite,
  AUTHORIZE_APP_NAME,
  AUTHORIZE_STATE_TTL_MINUTES,
  type AuthorizeState,
  type AuthorizeOptions,
} from './authorize';
