import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { HTTP_ERROR_CODES, HttpFetchError } from '@/lib/http';
import {
  POST_CONTENT_MAX_BYTES,
  POST_TITLE_MAX_LENGTH,
  WORDPRESS_POST_ERROR_CODES,
  contentHash,
  publishDraft,
  toPostStatus,
  type ExistingPost,
  type WordpressApiResponse,
  type WordpressClient,
  type WordpressRequest,
} from '@/modules/wordpress';

/**
 * 下書き投稿（TASKS C-3、SPEC 7.3）。
 *
 * 完了条件は「**`status: draft` 以外で投稿されない**」。
 * WordPress を模したクライアントで、送っている本文とメソッドを直接見る。
 */

const INPUT = { title: 'テスト記事', content: '<p>本文</p>' };

interface Recorded {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

interface FakeClient {
  client: WordpressClient;
  calls: Recorded[];
}

function createClient(
  responder: (
    input: WordpressRequest,
  ) => Partial<WordpressApiResponse> | Error = () => ({}),
): FakeClient {
  const calls: Recorded[] = [];

  return {
    calls,
    client: {
      async request(input) {
        calls.push({
          path: input.path,
          method: (input.method ?? 'GET').toUpperCase(),
          body: input.body as Record<string, unknown> | undefined,
        });

        const override = responder(input);
        if (override instanceof Error) {
          throw override;
        }

        const method = (input.method ?? 'GET').toUpperCase();
        const isCreate = input.path === '/wp/v2/posts' && method === 'POST';

        const fallback: Partial<WordpressApiResponse> = {
          status: isCreate ? 201 : 200,
          json: {
            id: 4242,
            status: 'draft',
            link: 'https://wp.example.com/?p=4242',
            content: {
              raw: (input.body as { content?: string })?.content ?? '',
            },
          },
        };

        const merged = Object.keys(override).length > 0 ? override : fallback;

        return {
          status: merged.status ?? 200,
          headers: merged.headers ?? {},
          json: merged.json ?? null,
          raw: JSON.stringify(merged.json ?? null),
        };
      },
    },
  };
}

const CAN_ALL = { canCreatePosts: true, canEditPosts: true };

describe('新規投稿', () => {
  // 完了条件そのもの
  it('必ず status: draft で作る', async () => {
    const { client, calls } = createClient();

    await publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL });

    expect(calls[0]).toMatchObject({ path: '/wp/v2/posts', method: 'POST' });
    expect(calls[0]?.body).toEqual({
      title: 'テスト記事',
      content: '<p>本文</p>',
      status: 'draft',
    });
  });

  it.each(['publish', 'pending', 'future', 'private'])(
    'draft 以外で作られたら失敗にする（%s）',
    async (status) => {
      const { client } = createClient(() => ({
        status: 201,
        json: { id: 9, status },
      }));

      await expect(
        publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL }),
      ).rejects.toMatchObject({
        code: WORDPRESS_POST_ERROR_CODES.notDraft,
      });
    },
  );

  it('作られた投稿の情報を返す', async () => {
    const { client } = createClient();

    const result = await publishDraft({
      client,
      input: INPUT,
      existing: null,
      ...CAN_ALL,
    });

    expect(result).toMatchObject({
      wpPostId: 4242,
      wpPostUrl: 'https://wp.example.com/?p=4242',
      wpStatus: 'DRAFT',
      created: true,
    });
  });

  it('投稿IDが返らなければ失敗にする', async () => {
    const { client } = createClient(() => ({
      status: 201,
      json: { status: 'draft' },
    }));

    await expect(
      publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL }),
    ).rejects.toMatchObject({ code: WORDPRESS_POST_ERROR_CODES.postFailed });
  });

  it('WordPress が拒否したら理由を伝える', async () => {
    const { client } = createClient(() => ({
      status: 401,
      json: {
        code: 'rest_cannot_create',
        message: '投稿の作成が許可されていません',
        data: { status: 401 },
      },
    }));

    await expect(
      publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL }),
    ).rejects.toMatchObject({
      code: WORDPRESS_POST_ERROR_CODES.postFailed,
      message: expect.stringContaining('許可されていません'),
    });
  });

  // 接続テスト（C-2）を通っていない接続で投稿しない
  it('作成権限が確認できていなければ投稿しない', async () => {
    const { client, calls } = createClient();

    await expect(
      publishDraft({
        client,
        input: INPUT,
        existing: null,
        canCreatePosts: false,
        canEditPosts: true,
      }),
    ).rejects.toThrow(AppError);

    expect(calls).toHaveLength(0);
  });
});

describe('既存投稿の更新', () => {
  const existing: ExistingPost = { wpPostId: 4242, wpStatus: 'DRAFT' };

  // SPEC 7.3「wp_post_id が存在する場合は新規投稿しない」
  it('新規作成せず既存の投稿を更新する', async () => {
    const { client, calls } = createClient();

    const result = await publishDraft({
      client,
      input: INPUT,
      existing,
      ...CAN_ALL,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/wp/v2/posts/4242');
    expect(result.created).toBe(false);
    expect(result.wpPostId).toBe(4242);
  });

  // SPEC 7.4。draft を送ると公開済みの記事を下書きへ戻してしまう
  it('更新では status を送らない', async () => {
    const { client, calls } = createClient();

    await publishDraft({ client, input: INPUT, existing, ...CAN_ALL });

    expect(calls[0]?.body).toEqual({
      title: 'テスト記事',
      content: '<p>本文</p>',
    });
    expect(calls[0]?.body).not.toHaveProperty('status');
  });

  it('編集権限が確認できていなければ更新しない', async () => {
    const { client, calls } = createClient();

    await expect(
      publishDraft({
        client,
        input: INPUT,
        existing,
        canCreatePosts: true,
        canEditPosts: false,
      }),
    ).rejects.toThrow(AppError);

    expect(calls).toHaveLength(0);
  });

  it('更新の失敗を伝える', async () => {
    const { client } = createClient(() => ({
      status: 404,
      json: {
        code: 'rest_post_invalid_id',
        message: '投稿が見つかりません',
        data: { status: 404 },
      },
    }));

    await expect(
      publishDraft({ client, input: INPUT, existing, ...CAN_ALL }),
    ).rejects.toMatchObject({
      code: WORDPRESS_POST_ERROR_CODES.postFailed,
      message: expect.stringContaining('見つかりません'),
    });
  });
});

describe('公開済み記事は上書きしない（DATA_MODEL 11章）', () => {
  it.each<ExistingPost['wpStatus']>(['PUBLISH', 'PENDING', 'TRASH'])(
    '%s の記事は更新しない',
    async (wpStatus) => {
      const { client, calls } = createClient();

      await expect(
        publishDraft({
          client,
          input: INPUT,
          existing: { wpPostId: 4242, wpStatus },
          ...CAN_ALL,
        }),
      ).rejects.toMatchObject({
        code: WORDPRESS_POST_ERROR_CODES.publishedNotEditable,
        status: 409,
      });

      // **1回もリクエストを出さない**
      expect(calls).toHaveLength(0);
    },
  );

  it('現在の状態をメッセージに含める', async () => {
    const { client } = createClient();

    await expect(
      publishDraft({
        client,
        input: INPUT,
        existing: { wpPostId: 4242, wpStatus: 'PUBLISH' },
        ...CAN_ALL,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('PUBLISH'),
    });
  });
});

describe('入力の検証', () => {
  it.each([
    ['タイトルが空', { title: '   ' }],
    ['本文が空', { content: '  ' }],
    ['タイトルが長すぎる', { title: 'あ'.repeat(POST_TITLE_MAX_LENGTH + 1) }],
    ['本文が大きすぎる', { content: 'x'.repeat(POST_CONTENT_MAX_BYTES + 1) }],
  ])('拒否する（%s）', async (_label, overrides) => {
    const { client, calls } = createClient();

    await expect(
      publishDraft({
        client,
        input: { ...INPUT, ...overrides },
        existing: null,
        ...CAN_ALL,
      }),
    ).rejects.toMatchObject({
      code: WORDPRESS_POST_ERROR_CODES.invalidContent,
    });

    expect(calls).toHaveLength(0);
  });
});

describe('通信の失敗', () => {
  it('到達できなければ unreachable。理由は返さない', async () => {
    const { client } = createClient(
      () =>
        new HttpFetchError(
          HTTP_ERROR_CODES.blockedAddress,
          '到達できないアドレスです',
          { detail: 'internal.example.com -> 10.0.0.1' },
        ),
    );

    try {
      await publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL });
      expect.unreachable('投稿できてしまった');
    } catch (error) {
      expect((error as AppError).code).toBe(
        WORDPRESS_POST_ERROR_CODES.unreachable,
      );
      expect((error as AppError).message).not.toContain('10.0.0.1');
    }
  });

  it('タイムアウトも unreachable', async () => {
    const { client } = createClient(
      () => new HttpFetchError(HTTP_ERROR_CODES.timeout, '応答なし'),
    );

    await expect(
      publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL }),
    ).rejects.toMatchObject({ code: WORDPRESS_POST_ERROR_CODES.unreachable });
  });

  it('想定外の例外も投稿失敗として扱う', async () => {
    const { client } = createClient(() => new Error('想定外'));

    await expect(
      publishDraft({ client, input: INPUT, existing: null, ...CAN_ALL }),
    ).rejects.toMatchObject({ code: WORDPRESS_POST_ERROR_CODES.postFailed });
  });
});

describe('本文のハッシュ', () => {
  // WordPress は保存時にサニタイズすることがある。送った側で計算すると
  // C-5 の同期で「利用者が編集した」と誤判定する
  it('WordPress が保存した本文に対して計算する', async () => {
    const stored = '<p>WordPressが整形した本文</p>';
    const { client } = createClient(() => ({
      status: 201,
      json: { id: 1, status: 'draft', content: { raw: stored } },
    }));

    const result = await publishDraft({
      client,
      input: INPUT,
      existing: null,
      ...CAN_ALL,
    });

    expect(result.contentHash).toBe(
      createHash('sha256').update(stored, 'utf8').digest('hex'),
    );
    expect(result.contentHash).not.toBe(contentHash(INPUT.content));
  });

  it('content.raw が無ければ送った本文で代用する', async () => {
    const { client } = createClient(() => ({
      status: 201,
      json: { id: 1, status: 'draft' },
    }));

    const result = await publishDraft({
      client,
      input: INPUT,
      existing: null,
      ...CAN_ALL,
    });

    expect(result.contentHash).toBe(contentHash(INPUT.content));
  });

  it('同じ本文なら同じハッシュになる', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });
});

describe('toPostStatus', () => {
  it.each([
    ['draft', 'DRAFT'],
    ['pending', 'PENDING'],
    ['publish', 'PUBLISH'],
    ['trash', 'TRASH'],
  ])('%s を %s にする', (value, expected) => {
    expect(toPostStatus(value)).toBe(expected);
  });

  it.each(['future', 'private', '', null, undefined, 42])(
    '知らない値は null（%s）',
    (value) => {
      expect(toPostStatus(value)).toBeNull();
    },
  );
});
