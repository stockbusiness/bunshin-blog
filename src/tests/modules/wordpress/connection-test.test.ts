import { describe, expect, it } from 'vitest';
import { HTTP_ERROR_CODES, HttpFetchError } from '@/lib/http';
import {
  CONNECTION_CHECK_IDS,
  TEST_POST_TITLE,
  WORDPRESS_TEST_ERROR_CODES,
  runConnectionTest,
  type ConnectionCheck,
  type ConnectionCheckId,
  type WordpressApiResponse,
  type WordpressClient,
  type WordpressRequest,
} from '@/modules/wordpress';

/**
 * 接続テストの7項目（TASKS C-2、SPEC 7.2）。
 *
 * WordPress を模したクライアントで確かめる。**応答の形は実際の
 * WordPress REST API に合わせる**（`{ code, message, data: { status } }`、
 * `Allow` ヘッダー、`namespaces` を含むルート）。
 */

const SITE_URL = 'https://monitor-blog.example.com';

interface Recorded {
  path: string;
  method: string;
  body: unknown;
  authenticated: boolean;
}

type Responder = (
  input: WordpressRequest,
) => Partial<WordpressApiResponse> | Error;

/** 実際の WordPress に近い既定の応答 */
function defaultResponder(
  input: WordpressRequest,
): Partial<WordpressApiResponse> {
  const method = (input.method ?? 'GET').toUpperCase();

  if (input.path === '/') {
    return {
      status: 200,
      json: { name: 'テストブログ', namespaces: ['wp/v2'] },
    };
  }

  if (input.path.startsWith('/wp/v2/users/me')) {
    return {
      status: 200,
      json: {
        id: 1,
        name: 'monitor',
        capabilities: {
          edit_posts: true,
          publish_posts: true,
          upload_files: true,
        },
      },
    };
  }

  if (input.path.startsWith('/wp/v2/posts?')) {
    return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
  }

  if (input.path === '/wp/v2/posts' && method === 'POST') {
    return { status: 201, json: { id: 4242, status: 'draft' } };
  }

  if (/^\/wp\/v2\/posts\/\d+$/.test(input.path) && method === 'POST') {
    return { status: 200, json: { id: 4242, status: 'draft' } };
  }

  if (input.path.startsWith('/wp/v2/posts/') && method === 'DELETE') {
    return { status: 200, json: { deleted: true } };
  }

  if (input.path.startsWith('/wp/v2/media')) {
    return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
  }

  return {
    status: 404,
    json: { code: 'rest_no_route', message: 'ルートが無い' },
  };
}

interface FakeClient {
  client: WordpressClient;
  calls: Recorded[];
}

function createClient(overrides: Responder[] = []): FakeClient {
  const calls: Recorded[] = [];

  return {
    calls,
    client: {
      async request(input) {
        calls.push({
          path: input.path,
          method: (input.method ?? 'GET').toUpperCase(),
          body: input.body,
          authenticated: input.authenticated !== false,
        });

        for (const override of overrides) {
          const result = override(input);
          if (result instanceof Error) {
            throw result;
          }
          if (Object.keys(result).length > 0) {
            return {
              status: result.status ?? 200,
              headers: result.headers ?? {},
              json: result.json ?? null,
              raw: JSON.stringify(result.json ?? null),
            };
          }
        }

        const fallback = defaultResponder(input);

        return {
          status: fallback.status ?? 200,
          headers: fallback.headers ?? {},
          json: fallback.json ?? null,
          raw: JSON.stringify(fallback.json ?? null),
        };
      },
    },
  };
}

/** 指定パスにだけ別の応答を返す差し替えを作る */
function when(
  matcher: (input: WordpressRequest) => boolean,
  response: Partial<WordpressApiResponse> | Error,
): Responder {
  return (input) => (matcher(input) ? response : {});
}

function check(
  checks: readonly ConnectionCheck[],
  id: ConnectionCheckId,
): ConnectionCheck {
  const found = checks.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`${id} の結果がありません`);
  }

  return found;
}

describe('runConnectionTest（全て成功）', () => {
  it('7項目すべてを PASSED にする', async () => {
    const { client } = createClient();

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(result.ok).toBe(true);
    expect(result.checks.map((item) => item.id)).toEqual([
      ...CONNECTION_CHECK_IDS,
    ]);
    for (const item of result.checks) {
      expect(item.status).toBe('PASSED');
    }
  });

  it('権限を全て true にする', async () => {
    const { client } = createClient();

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(result.canCreatePosts).toBe(true);
    expect(result.canEditPosts).toBe(true);
    expect(result.canUploadMedia).toBe(true);
    expect(result.failedCode).toBeNull();
  });

  // SPEC 7.3「初期モニター期間は status: draft」
  it('テスト投稿を必ず下書きで作る', async () => {
    const { client, calls } = createClient();

    await runConnectionTest({ siteUrl: SITE_URL, client });

    const created = calls.find(
      (call) => call.path === '/wp/v2/posts' && call.method === 'POST',
    );
    expect(created?.body).toMatchObject({
      title: TEST_POST_TITLE,
      status: 'draft',
    });
  });

  // SPEC 7.2 の8番目「テスト投稿は作成後に削除または下書き保持」
  it('テスト投稿を消す', async () => {
    const { client, calls } = createClient();

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    const deleted = calls.find((call) => call.method === 'DELETE');
    expect(deleted?.path).toBe('/wp/v2/posts/4242?force=true');
    expect(result.leftoverPostId).toBeNull();
  });

  it('到達確認だけは認証を付けずに叩く', async () => {
    const { client, calls } = createClient();

    await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(calls[0]?.path).toBe('/');
    expect(calls[0]?.authenticated).toBe(false);
    expect(calls.slice(1).every((call) => call.authenticated)).toBe(true);
  });
});

describe('1. URL形式', () => {
  it('保存済みURLの形式が不正なら以降を実施しない', async () => {
    const { client, calls } = createClient();

    const result = await runConnectionTest({
      siteUrl: 'http://192.168.0.1',
      client,
    });

    expect(check(result.checks, 'URL_FORMAT')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.invalidUrl,
    });
    expect(check(result.checks, 'REST_REACHABLE').status).toBe('SKIPPED');
    expect(calls).toHaveLength(0);
  });
});

describe('2. REST API到達', () => {
  it('到達できなければ unreachable', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/',
        new HttpFetchError(HTTP_ERROR_CODES.requestFailed, '接続できません'),
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'REST_REACHABLE')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.unreachable,
    });
    expect(check(result.checks, 'AUTH').status).toBe('SKIPPED');
  });

  it('タイムアウトも unreachable として扱う', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/',
        new HttpFetchError(HTTP_ERROR_CODES.timeout, '応答なし'),
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'REST_REACHABLE').code).toBe(
      WORDPRESS_TEST_ERROR_CODES.unreachable,
    );
  });

  // 到達禁止アドレスと通信エラーを区別すると、内部構成を外から調べられる
  it('到達禁止アドレスでも理由を返さない', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/',
        new HttpFetchError(
          HTTP_ERROR_CODES.blockedAddress,
          '到達できないアドレスです',
          { detail: 'internal.example.com -> 10.0.0.1' },
        ),
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });
    const reachable = check(result.checks, 'REST_REACHABLE');

    expect(reachable.code).toBe(WORDPRESS_TEST_ERROR_CODES.unreachable);
    expect(reachable.message).not.toContain('10.0.0.1');
    expect(reachable.message).not.toContain('internal');
  });

  it('JSON以外が返れば notWordpress', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/',
        new HttpFetchError(
          HTTP_ERROR_CODES.unexpectedContentType,
          '応答の種類が想定と違います',
        ),
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });
    const reachable = check(result.checks, 'REST_REACHABLE');

    expect(reachable.code).toBe(WORDPRESS_TEST_ERROR_CODES.notWordpress);
    expect(reachable.message).toContain('パーマリンク');
  });

  it('wp/v2 の名前空間が無ければ notWordpress', async () => {
    const { client } = createClient([
      when((input) => input.path === '/', {
        status: 200,
        json: { namespaces: ['oembed/1.0'] },
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'REST_REACHABLE').code).toBe(
      WORDPRESS_TEST_ERROR_CODES.notWordpress,
    );
  });

  it('ルートが 404 なら notWordpress', async () => {
    const { client } = createClient([
      when((input) => input.path === '/', { status: 404, json: {} }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'REST_REACHABLE').code).toBe(
      WORDPRESS_TEST_ERROR_CODES.notWordpress,
    );
  });
});

describe('3. 認証成功', () => {
  it.each([401, 403])('%d なら authFailed', async (status) => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/users/me'), {
        status,
        json: {
          code: 'rest_not_logged_in',
          message: 'ログインしていません',
          data: { status },
        },
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'AUTH')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.authFailed,
    });
    expect(check(result.checks, 'LIST_POSTS').status).toBe('SKIPPED');
  });

  it('WordPress の説明をモニターへ伝える', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/users/me'), {
        status: 401,
        json: {
          code: 'incorrect_password',
          message: 'パスワードが違います',
          data: { status: 401 },
        },
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'AUTH').message).toContain(
      'パスワードが違います',
    );
  });

  it('認証に失敗したら投稿を作らない', async () => {
    const { client, calls } = createClient([
      when((input) => input.path.startsWith('/wp/v2/users/me'), {
        status: 401,
        json: {},
      }),
    ]);

    await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('500 でも authFailed として止める', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/users/me'), {
        status: 500,
        json: {},
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'AUTH').code).toBe(
      WORDPRESS_TEST_ERROR_CODES.authFailed,
    );
  });
});

describe('4. 投稿一覧取得', () => {
  it('取得できなければ cannotListPosts', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/posts?'), {
        status: 403,
        json: {
          code: 'rest_forbidden',
          message: '閲覧が許可されていません',
          data: { status: 403 },
        },
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'LIST_POSTS')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotListPosts,
    });
    expect(check(result.checks, 'CREATE_DRAFT').status).toBe('SKIPPED');
  });
});

describe('5. 下書き作成権限', () => {
  it('作成できなければ cannotCreatePosts', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/wp/v2/posts' && input.method === 'POST',
        {
          status: 401,
          json: {
            code: 'rest_cannot_create',
            message: '投稿の作成が許可されていません',
            data: { status: 401 },
          },
        },
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'CREATE_DRAFT')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotCreatePosts,
    });
    expect(result.canCreatePosts).toBe(false);
    expect(check(result.checks, 'EDIT_POST').status).toBe('SKIPPED');
  });

  // 公開されると事故になる（SPEC 7.3）
  it('下書き以外で作られたら失敗にし、残骸として報告する', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/wp/v2/posts' && input.method === 'POST',
        { status: 201, json: { id: 99, status: 'publish' } },
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'CREATE_DRAFT')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotCreatePosts,
    });
    expect(check(result.checks, 'CREATE_DRAFT').message).toContain('publish');
    expect(result.leftoverPostId).toBe(99);
  });
});

describe('6. 編集権限', () => {
  it('編集できなければ cannotEditPosts。ただし後続は続ける', async () => {
    const { client } = createClient([
      when(
        (input) =>
          /^\/wp\/v2\/posts\/\d+$/.test(input.path) && input.method === 'POST',
        {
          status: 403,
          json: {
            code: 'rest_cannot_edit',
            message: '編集が許可されていません',
            data: { status: 403 },
          },
        },
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'EDIT_POST')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotEditPosts,
    });
    expect(result.canEditPosts).toBe(false);
    // 作成は通っている
    expect(result.canCreatePosts).toBe(true);
    // メディアの確認は続ける
    expect(check(result.checks, 'MEDIA').status).toBe('PASSED');
  });

  it('作成の応答にIDが無ければ編集を確認できない', async () => {
    const { client } = createClient([
      when(
        (input) => input.path === '/wp/v2/posts' && input.method === 'POST',
        { status: 201, json: { status: 'draft' } },
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'EDIT_POST')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotEditPosts,
    });
  });
});

describe('7. メディア権限', () => {
  // モニターのメディアライブラリを汚さない
  it('実際にはアップロードしない', async () => {
    const { client, calls } = createClient();

    await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(
      calls.some(
        (call) => call.path.startsWith('/wp/v2/media') && call.method !== 'GET',
      ),
    ).toBe(false);
  });

  it('Allow に POST が無ければ cannotUploadMedia', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/media'), {
        status: 200,
        headers: { allow: 'GET' },
        json: [],
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'MEDIA')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotUploadMedia,
    });
    expect(result.canUploadMedia).toBe(false);
  });

  it('Allow が無ければ capabilities で判定する', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/media'), {
        status: 200,
        headers: {},
        json: [],
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'MEDIA').status).toBe('PASSED');
    expect(result.canUploadMedia).toBe(true);
  });

  it('Allow も capabilities も無ければ判定できないものとして失敗にする', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/users/me'), {
        status: 200,
        json: { id: 1 },
      }),
      when((input) => input.path.startsWith('/wp/v2/media'), {
        status: 200,
        headers: {},
        json: [],
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'MEDIA')).toMatchObject({
      status: 'FAILED',
      code: WORDPRESS_TEST_ERROR_CODES.cannotUploadMedia,
    });
  });

  it('403 なら cannotUploadMedia', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/media'), {
        status: 403,
        json: {
          code: 'rest_forbidden',
          message: '許可されていません',
          data: { status: 403 },
        },
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(check(result.checks, 'MEDIA').code).toBe(
      WORDPRESS_TEST_ERROR_CODES.cannotUploadMedia,
    );
  });
});

describe('8. テスト投稿の後始末', () => {
  it('消せなければ投稿IDを残骸として返す', async () => {
    const { client } = createClient([
      when((input) => input.method === 'DELETE', {
        status: 403,
        json: {
          code: 'rest_cannot_delete',
          message: '削除が許可されていません',
          data: { status: 403 },
        },
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(result.leftoverPostId).toBe(4242);
    // 削除できないことは接続の失敗ではない
    expect(result.ok).toBe(true);
  });

  it('削除で通信エラーになっても結果を返す', async () => {
    const { client } = createClient([
      when(
        (input) => input.method === 'DELETE',
        new HttpFetchError(HTTP_ERROR_CODES.timeout, '応答なし'),
      ),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(result.leftoverPostId).toBe(4242);
    expect(result.ok).toBe(true);
  });
});

describe('結果のまとめ', () => {
  it('最初に失敗した項目を failedCode に入れる', async () => {
    const { client } = createClient([
      when((input) => input.path.startsWith('/wp/v2/posts?'), {
        status: 403,
        json: {},
      }),
    ]);

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    expect(result.ok).toBe(false);
    expect(result.failedCode).toBe(WORDPRESS_TEST_ERROR_CODES.cannotListPosts);
    expect(result.failedMessage).not.toBeNull();
  });

  it('項目ごとに別のコードを返す（完了条件）', async () => {
    const codes = new Set<string>();

    const cases: { matcher: (input: WordpressRequest) => boolean }[] = [
      { matcher: (input) => input.path.startsWith('/wp/v2/users/me') },
      { matcher: (input) => input.path.startsWith('/wp/v2/posts?') },
      {
        matcher: (input) =>
          input.path === '/wp/v2/posts' && input.method === 'POST',
      },
      {
        matcher: (input) =>
          /^\/wp\/v2\/posts\/\d+$/.test(input.path) && input.method === 'POST',
      },
      { matcher: (input) => input.path.startsWith('/wp/v2/media') },
    ];

    for (const item of cases) {
      const { client } = createClient([
        when(item.matcher, { status: 403, json: {} }),
      ]);
      const result = await runConnectionTest({ siteUrl: SITE_URL, client });
      if (result.failedCode !== null) {
        codes.add(result.failedCode);
      }
    }

    expect(codes.size).toBe(cases.length);
  });

  it('結果に認証情報が混ざらない', async () => {
    const { client } = createClient();

    const result = await runConnectionTest({ siteUrl: SITE_URL, client });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Basic ');
    expect(serialized).not.toContain('authorization');
  });
});
