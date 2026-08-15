/**
 * WordPress の接続テスト（TASKS C-2、SPEC 7.2）。
 *
 * SPEC 7.2 が定める確認は次のとおり。
 *
 * 1. URL形式
 * 2. REST API到達
 * 3. 認証成功
 * 4. 投稿一覧取得
 * 5. 下書き作成権限
 * 6. 編集権限
 * 7. メディア権限
 * 8. テスト投稿は作成後に削除または下書き保持
 *
 * **項目ごとに別のエラーコードを返す。** 「接続できません」だけでは
 * モニターが何を直せばよいか分からない。
 *
 * **最初の失敗で止めない。** 分かるところまで進めて全項目の結果を返す。
 * ただし前提が崩れた項目（認証できていないのに権限を見る等）は
 * `SKIPPED` にする。存在しない結果を「失敗」として出さないため。
 *
 * DBを触らない。保存は `repository.ts` の担当。
 */

import { scrubString } from '@/lib/logger';
import { isHttpFetchError, HTTP_ERROR_CODES } from '@/lib/http';
import {
  allowsMethod,
  readWordpressError,
  type WordpressClient,
} from './client';
import { WORDPRESS_TEST_ERROR_CODES } from './errors';
import { normalizeSiteUrl } from './site-url';

export const CONNECTION_CHECK_IDS = [
  'URL_FORMAT',
  'REST_REACHABLE',
  'AUTH',
  'LIST_POSTS',
  'CREATE_DRAFT',
  'EDIT_POST',
  'MEDIA',
] as const;

export type ConnectionCheckId = (typeof CONNECTION_CHECK_IDS)[number];

export type ConnectionCheckStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

export interface ConnectionCheck {
  id: ConnectionCheckId;
  status: ConnectionCheckStatus;
  /** 失敗した項目のコード。成功・未実施なら `null` */
  code: string | null;
  /** モニターへ見せる説明。WordPress の文言を混ぜる場合はマスク済み */
  message: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  checks: ConnectionCheck[];
  canCreatePosts: boolean;
  canEditPosts: boolean;
  canUploadMedia: boolean;
  /** 最初に失敗した項目。保存して一覧に出す */
  failedCode: string | null;
  failedMessage: string | null;
  /** 後始末できなかったテスト投稿。残っていればモニターに知らせる */
  leftoverPostId: number | null;
}

/** テスト投稿のタイトル。モニターが見て分かる文言にする */
export const TEST_POST_TITLE = '【BUNSHIN BLOG】接続テスト';

const TEST_POST_CONTENT =
  'この記事は接続テストで自動作成されました。テスト終了後に削除されます。';

interface CheckContext {
  client: WordpressClient;
  checks: ConnectionCheck[];
}

function record(
  context: CheckContext,
  id: ConnectionCheckId,
  status: ConnectionCheckStatus,
  code: string | null = null,
  message: string | null = null,
): void {
  context.checks.push({
    id,
    status,
    code,
    message: message === null ? null : scrubString(message),
  });
}

function skipRest(context: CheckContext, from: ConnectionCheckId): void {
  const start = CONNECTION_CHECK_IDS.indexOf(from);
  for (const id of CONNECTION_CHECK_IDS.slice(start)) {
    record(context, id, 'SKIPPED');
  }
}

/**
 * 到達できなかった原因を項目のコードへ翻訳する。
 *
 * **到達禁止アドレスと通信エラーを区別しない**（どちらも `unreachable`）。
 * 「そのホストは内部アドレスへ解決された」と返すと、内部ネットワークの
 * 構成を外から調べられる（SPEC 14.3 の趣旨）。理由はログにのみ残す。
 */
function describeTransportFailure(error: unknown): {
  code: string;
  message: string;
} {
  if (!isHttpFetchError(error)) {
    return {
      code: WORDPRESS_TEST_ERROR_CODES.unreachable,
      message: 'サイトへ接続できませんでした',
    };
  }

  if (error.code === HTTP_ERROR_CODES.unexpectedContentType) {
    // **どこで何を変えるかまで書く**（本番で実際にここで止まった・2026-08-15）。
    //
    // WordPress は**パーマリンクが「基本」のとき `/wp-json/` の
    // 書き換え規則を作らない。** そのため404のHTMLが返る。
    //
    // **`?rest_route=` で回避しない。** 「基本」のままだと段10で入れる
    // `/go/{code}` も同じ理由で404になる。**ここで止めないと、
    // 失敗が後ろへずれて原因が分からなくなる。**
    return {
      code: WORDPRESS_TEST_ERROR_CODES.notWordpress,
      message:
        'WordPress の REST API が応答しませんでした。' +
        '管理画面の「設定 → パーマリンク」を開き、' +
        '「基本」以外（「投稿名」を推奨）に変えて保存してから、もう一度お試しください',
    };
  }

  if (error.code === HTTP_ERROR_CODES.timeout) {
    return {
      code: WORDPRESS_TEST_ERROR_CODES.unreachable,
      message: 'サイトが時間内に応答しませんでした',
    };
  }

  return {
    code: WORDPRESS_TEST_ERROR_CODES.unreachable,
    message: 'サイトへ接続できませんでした',
  };
}

/** `/wp-json/` の応答に `wp/v2` の名前空間があるか */
function hasWpV2Namespace(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) {
    return false;
  }

  const namespaces = (json as Record<string, unknown>)['namespaces'];

  return Array.isArray(namespaces) && namespaces.includes('wp/v2');
}

/** `/wp/v2/users/me?context=edit` から権限一覧を読む */
function readCapabilities(json: unknown): Record<string, boolean> | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const capabilities = (json as Record<string, unknown>)['capabilities'];
  if (typeof capabilities !== 'object' || capabilities === null) {
    return null;
  }

  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    result[key] = value === true;
  }

  return result;
}

function newPostId(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const id = (json as Record<string, unknown>)['id'];

  return typeof id === 'number' ? id : null;
}

function postStatus(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const status = (json as Record<string, unknown>)['status'];

  return typeof status === 'string' ? status : null;
}

/**
 * WordPress のエラー応答から、モニターへ見せる文言を作る。
 *
 * WordPress の `message` はそのまま出す。管理者が設定を直すのに要る情報で、
 * 秘密情報は含まれない。念のため `scrubString` は `record` 側で通す。
 */
function apiMessage(fallback: string, json: unknown): string {
  const error = readWordpressError(json);

  return error === null ? fallback : `${fallback}（${error.message}）`;
}

/**
 * 接続テストを実行する。
 *
 * @param siteUrl 保存済みの `site_url`。形式の再確認に使う
 * @param client 認証情報を持ったクライアント
 */
export async function runConnectionTest(params: {
  siteUrl: string;
  client: WordpressClient;
}): Promise<ConnectionTestResult> {
  const context: CheckContext = { client: params.client, checks: [] };

  let canCreatePosts = false;
  let canEditPosts = false;
  let canUploadMedia = false;
  let leftoverPostId: number | null = null;

  // --- 1. URL形式 ---------------------------------------------------------
  // C-1 で正規化して保存しているため通常は通る。C-1 より前に入った行や、
  // SQLで直接書き換えられた行を検出するための確認
  try {
    normalizeSiteUrl(params.siteUrl);
    record(context, 'URL_FORMAT', 'PASSED');
  } catch {
    record(
      context,
      'URL_FORMAT',
      'FAILED',
      WORDPRESS_TEST_ERROR_CODES.invalidUrl,
      '保存されているサイトURLの形式が不正です。接続し直してください',
    );
    skipRest(context, 'REST_REACHABLE');

    return finish(context, {
      canCreatePosts,
      canEditPosts,
      canUploadMedia,
      leftoverPostId,
    });
  }

  // --- 2. REST API到達 ----------------------------------------------------
  // 認証を付けずに叩く。認証で落ちたのか到達できないのかを分けるため
  try {
    const root = await context.client.request({
      path: '/',
      authenticated: false,
    });

    if (root.status >= 400 || !hasWpV2Namespace(root.json)) {
      record(
        context,
        'REST_REACHABLE',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.notWordpress,
        'WordPress の REST API が見つかりませんでした',
      );
      skipRest(context, 'AUTH');

      return finish(context, {
        canCreatePosts,
        canEditPosts,
        canUploadMedia,
        leftoverPostId,
      });
    }

    record(context, 'REST_REACHABLE', 'PASSED');
  } catch (error) {
    const { code, message } = describeTransportFailure(error);
    record(context, 'REST_REACHABLE', 'FAILED', code, message);
    skipRest(context, 'AUTH');

    return finish(context, {
      canCreatePosts,
      canEditPosts,
      canUploadMedia,
      leftoverPostId,
    });
  }

  // --- 3. 認証成功 --------------------------------------------------------
  let capabilities: Record<string, boolean> | null = null;

  try {
    const me = await context.client.request({
      path: '/wp/v2/users/me?context=edit',
    });

    if (me.status === 401 || me.status === 403) {
      record(
        context,
        'AUTH',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.authFailed,
        apiMessage(
          'ユーザー名またはアプリケーションパスワードが違います',
          me.json,
        ),
      );
      skipRest(context, 'LIST_POSTS');

      return finish(context, {
        canCreatePosts,
        canEditPosts,
        canUploadMedia,
        leftoverPostId,
      });
    }

    if (me.status >= 400) {
      record(
        context,
        'AUTH',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.authFailed,
        apiMessage('認証を確認できませんでした', me.json),
      );
      skipRest(context, 'LIST_POSTS');

      return finish(context, {
        canCreatePosts,
        canEditPosts,
        canUploadMedia,
        leftoverPostId,
      });
    }

    capabilities = readCapabilities(me.json);
    record(context, 'AUTH', 'PASSED');
  } catch (error) {
    const { code, message } = describeTransportFailure(error);
    record(context, 'AUTH', 'FAILED', code, message);
    skipRest(context, 'LIST_POSTS');

    return finish(context, {
      canCreatePosts,
      canEditPosts,
      canUploadMedia,
      leftoverPostId,
    });
  }

  // --- 4. 投稿一覧取得 ----------------------------------------------------
  try {
    const list = await context.client.request({
      path: '/wp/v2/posts?per_page=1&status=draft&context=edit',
    });

    if (list.status >= 400) {
      record(
        context,
        'LIST_POSTS',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.cannotListPosts,
        apiMessage('投稿一覧を取得できませんでした', list.json),
      );
      skipRest(context, 'CREATE_DRAFT');

      return finish(context, {
        canCreatePosts,
        canEditPosts,
        canUploadMedia,
        leftoverPostId,
      });
    }

    record(context, 'LIST_POSTS', 'PASSED');
  } catch (error) {
    const { code, message } = describeTransportFailure(error);
    record(context, 'LIST_POSTS', 'FAILED', code, message);
    skipRest(context, 'CREATE_DRAFT');

    return finish(context, {
      canCreatePosts,
      canEditPosts,
      canUploadMedia,
      leftoverPostId,
    });
  }

  // --- 5. 下書き作成権限 --------------------------------------------------
  // **実際に作る。** SPEC 7.2 の8番目が「テスト投稿は作成後に削除または
  // 下書き保持」としており、作成を伴う前提になっている。
  // **必ず status: draft で作る**（SPEC 7.3）。公開されると事故になる
  let createdPostId: number | null = null;

  try {
    const created = await context.client.request({
      path: '/wp/v2/posts',
      method: 'POST',
      body: {
        title: TEST_POST_TITLE,
        content: TEST_POST_CONTENT,
        status: 'draft',
      },
    });

    if (created.status >= 400) {
      record(
        context,
        'CREATE_DRAFT',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.cannotCreatePosts,
        apiMessage('下書きを作成する権限がありません', created.json),
      );
      skipRest(context, 'EDIT_POST');

      return finish(context, {
        canCreatePosts,
        canEditPosts,
        canUploadMedia,
        leftoverPostId,
      });
    }

    createdPostId = newPostId(created.json);

    // 下書き以外で作られたら、その時点で異常として扱う（SPEC 7.3）
    const status = postStatus(created.json);
    if (status !== null && status !== 'draft') {
      leftoverPostId = createdPostId;
      record(
        context,
        'CREATE_DRAFT',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.cannotCreatePosts,
        `下書きとして作成されませんでした（${status}）`,
      );
      skipRest(context, 'EDIT_POST');

      return finish(context, {
        canCreatePosts,
        canEditPosts,
        canUploadMedia,
        leftoverPostId,
      });
    }

    canCreatePosts = true;
    record(context, 'CREATE_DRAFT', 'PASSED');
  } catch (error) {
    const { code, message } = describeTransportFailure(error);
    record(context, 'CREATE_DRAFT', 'FAILED', code, message);
    skipRest(context, 'EDIT_POST');

    return finish(context, {
      canCreatePosts,
      canEditPosts,
      canUploadMedia,
      leftoverPostId,
    });
  }

  // --- 6. 編集権限 --------------------------------------------------------
  if (createdPostId === null) {
    // 作成は通ったのにIDが返らない。更新の確認ができない
    record(
      context,
      'EDIT_POST',
      'FAILED',
      WORDPRESS_TEST_ERROR_CODES.cannotEditPosts,
      '作成した投稿のIDを取得できませんでした',
    );
  } else {
    try {
      const updated = await context.client.request({
        path: `/wp/v2/posts/${createdPostId}`,
        method: 'POST',
        body: { title: `${TEST_POST_TITLE}（更新確認）` },
      });

      if (updated.status >= 400) {
        record(
          context,
          'EDIT_POST',
          'FAILED',
          WORDPRESS_TEST_ERROR_CODES.cannotEditPosts,
          apiMessage('投稿を編集する権限がありません', updated.json),
        );
      } else {
        canEditPosts = true;
        record(context, 'EDIT_POST', 'PASSED');
      }
    } catch (error) {
      const { code, message } = describeTransportFailure(error);
      record(context, 'EDIT_POST', 'FAILED', code, message);
    }
  }

  // --- 7. メディア権限 ----------------------------------------------------
  // **実際にはアップロードしない。** モニターのメディアライブラリへ
  // テストのたびにファイルが増えるのは避ける。WordPress が返す `Allow`
  // ヘッダーと `capabilities` で判定する
  try {
    const media = await context.client.request({
      path: '/wp/v2/media?per_page=1&context=edit',
    });

    if (media.status >= 400) {
      record(
        context,
        'MEDIA',
        'FAILED',
        WORDPRESS_TEST_ERROR_CODES.cannotUploadMedia,
        apiMessage('メディアを扱う権限がありません', media.json),
      );
    } else {
      const allowed = allowsMethod(media.headers, 'POST');
      const fromCapabilities = capabilities?.['upload_files'] ?? null;
      // `Allow` を優先する。無い環境（プラグインで外される）では
      // `capabilities` へ落とす
      const decided = allowed ?? fromCapabilities;

      if (decided === true) {
        canUploadMedia = true;
        record(context, 'MEDIA', 'PASSED');
      } else if (decided === false) {
        record(
          context,
          'MEDIA',
          'FAILED',
          WORDPRESS_TEST_ERROR_CODES.cannotUploadMedia,
          'メディアをアップロードする権限がありません',
        );
      } else {
        record(
          context,
          'MEDIA',
          'FAILED',
          WORDPRESS_TEST_ERROR_CODES.cannotUploadMedia,
          'メディアの権限を確認できませんでした',
        );
      }
    }
  } catch (error) {
    const { code, message } = describeTransportFailure(error);
    record(context, 'MEDIA', 'FAILED', code, message);
  }

  // --- 8. テスト投稿の後始末 ----------------------------------------------
  // **消す。** 毎回の接続テストで下書きが増えると、モニターの管理画面が
  // テスト投稿で埋まる。消せなければ残骸として報告する
  if (createdPostId !== null) {
    leftoverPostId = await cleanupTestPost(context.client, createdPostId);
  }

  return finish(context, {
    canCreatePosts,
    canEditPosts,
    canUploadMedia,
    leftoverPostId,
  });
}

/**
 * テスト投稿を消す。消せなければ投稿IDを返す（残骸）。
 *
 * `force=true` でゴミ箱を経由せずに消す。ゴミ箱に残ると、結局モニターが
 * 手で消すことになる。
 */
async function cleanupTestPost(
  client: WordpressClient,
  postId: number,
): Promise<number | null> {
  try {
    const deleted = await client.request({
      path: `/wp/v2/posts/${postId}?force=true`,
      method: 'DELETE',
    });

    return deleted.status >= 400 ? postId : null;
  } catch {
    return postId;
  }
}

function finish(
  context: CheckContext,
  state: {
    canCreatePosts: boolean;
    canEditPosts: boolean;
    canUploadMedia: boolean;
    leftoverPostId: number | null;
  },
): ConnectionTestResult {
  const failed = context.checks.find((check) => check.status === 'FAILED');

  return {
    ok: failed === undefined,
    checks: context.checks,
    canCreatePosts: state.canCreatePosts,
    canEditPosts: state.canEditPosts,
    canUploadMedia: state.canUploadMedia,
    failedCode: failed?.code ?? null,
    failedMessage: failed?.message ?? null,
    leftoverPostId: state.leftoverPostId,
  };
}
