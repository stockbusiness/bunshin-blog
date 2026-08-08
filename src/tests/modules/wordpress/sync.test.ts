import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { HTTP_ERROR_CODES, HttpFetchError } from '@/lib/http';
import {
  WORDPRESS_SYNC_ERROR_CODES,
  contentHash,
  fetchRemotePost,
  isUserEdited,
  syncPost,
  type WordpressApiResponse,
  type WordpressClient,
  type WordpressRequest,
} from '@/modules/wordpress';

/**
 * WordPress 側の状態の取り込み（TASKS C-5、DATA_MODEL 11章）。
 *
 * 見たいのは3つ。**公開状態を取り込むこと**、**利用者の編集を
 * ハッシュで判定すること**、**判別できない状態を推測で埋めないこと**。
 */

const RAW = '<p>こちらが書いた本文</p>';
const HASH = contentHash(RAW);

interface Recorded {
  path: string;
  method: string;
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
        });

        const override = responder(input);
        if (override instanceof Error) {
          throw override;
        }

        return {
          status: 200,
          headers: {},
          raw: '',
          json: {
            id: 4242,
            status: 'draft',
            link: 'https://example.com/?p=4242',
            date_gmt: '2026-08-08T01:00:00',
            content: { raw: RAW, rendered: '<p>整形後</p>' },
          },
          ...override,
        };
      },
    },
  };
}

describe('fetchRemotePost', () => {
  /** `content.raw` は `context=edit` でしか返らない */
  it('context=edit で取りに行く', async () => {
    const { client, calls } = createClient();

    await fetchRemotePost({ client, wpPostId: 4242 });

    expect(calls).toEqual([
      { path: '/wp/v2/posts/4242?context=edit', method: 'GET' },
    ]);
  });

  it('状態と本文のハッシュを返す', async () => {
    const { client } = createClient();

    const result = await fetchRemotePost({ client, wpPostId: 4242 });

    expect(result).toMatchObject({
      wpStatus: 'DRAFT',
      contentHash: HASH,
      wpPostUrl: 'https://example.com/?p=4242',
    });
  });

  /**
   * **`rendered` を比較に使わない。** ショートコードの展開や整形フィルタを
   * 通った後の文字列で、誰も編集していなくても変わりうる。
   */
  it('rendered ではなく raw のハッシュを使う', async () => {
    const { client } = createClient(() => ({
      json: {
        status: 'draft',
        content: { raw: RAW, rendered: '<p>まったく違う整形結果</p>' },
      },
    }));

    const result = await fetchRemotePost({ client, wpPostId: 4242 });

    expect(result.contentHash).toBe(HASH);
  });

  it.each([
    ['publish', 'PUBLISH'],
    ['draft', 'DRAFT'],
    ['pending', 'PENDING'],
    ['trash', 'TRASH'],
  ])('%s を取り込む', async (remote, expected) => {
    const { client } = createClient(() => ({
      json: { status: remote, content: { raw: RAW } },
    }));

    expect((await fetchRemotePost({ client, wpPostId: 4242 })).wpStatus).toBe(
      expected,
    );
  });

  /**
   * `future`（予約投稿）・`private` など。
   * **知らない状態を下書き扱いに倒さない**（C-3 と同じ方針）。
   */
  it.each(['future', 'private', 'auto-draft', ''])(
    '判別できない状態 %s では失敗する',
    async (status) => {
      const { client } = createClient(() => ({
        json: { status, content: { raw: RAW } },
      }));

      await expect(
        fetchRemotePost({ client, wpPostId: 4242 }),
      ).rejects.toMatchObject({
        code: WORDPRESS_SYNC_ERROR_CODES.unknownStatus,
      });
    },
  );

  /**
   * **本文なしで「未編集」と判定してはならない。**
   * `context=edit` が権限不足で通らないと `raw` が返らない。
   */
  it('本文が取れなければ失敗する', async () => {
    const { client } = createClient(() => ({
      json: { status: 'draft', content: { rendered: '<p>整形後</p>' } },
    }));

    await expect(
      fetchRemotePost({ client, wpPostId: 4242 }),
    ).rejects.toMatchObject({
      code: WORDPRESS_SYNC_ERROR_CODES.contentUnavailable,
    });
  });

  it('記事が消えていれば専用のコードで返す', async () => {
    const { client } = createClient(() => ({
      status: 404,
      json: { code: 'rest_post_invalid_id', message: '見つかりません' },
    }));

    await expect(
      fetchRemotePost({ client, wpPostId: 4242 }),
    ).rejects.toMatchObject({
      code: WORDPRESS_SYNC_ERROR_CODES.postGone,
      status: 404,
    });
  });

  it('権限不足を伝える', async () => {
    const { client } = createClient(() => ({
      status: 403,
      json: { code: 'rest_forbidden', message: '権限がありません' },
    }));

    await expect(
      fetchRemotePost({ client, wpPostId: 4242 }),
    ).rejects.toMatchObject({
      code: WORDPRESS_SYNC_ERROR_CODES.syncFailed,
      message: expect.stringContaining('権限がありません'),
    });
  });

  // 到達できない理由を細かく返さない（SPEC 14.3）
  it('到達できない理由を明かさない', async () => {
    const { client } = createClient(
      () =>
        new HttpFetchError(
          HTTP_ERROR_CODES.blockedAddress,
          '10.0.0.1 は到達禁止',
        ),
    );

    const error: unknown = await fetchRemotePost({
      client,
      wpPostId: 4242,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(
      WORDPRESS_SYNC_ERROR_CODES.unreachable,
    );
    expect((error as AppError).message).not.toContain('10.0.0.1');
  });
});

describe('公開日時', () => {
  it('公開されていれば date_gmt を UTC として取り込む', async () => {
    const { client } = createClient(() => ({
      json: {
        status: 'publish',
        date_gmt: '2026-08-08T01:00:00',
        content: { raw: RAW },
      },
    }));

    const result = await fetchRemotePost({ client, wpPostId: 4242 });

    expect(result.publishedAt?.toISOString()).toBe('2026-08-08T01:00:00.000Z');
  });

  /**
   * 下書きにも `date_gmt` は入っている。そのまま入れると
   * 「まだ公開していない記事に公開日時がある」ことになる。
   */
  it.each(['draft', 'pending', 'trash'])(
    '%s では公開日時を入れない',
    async (status) => {
      const { client } = createClient(() => ({
        json: {
          status,
          date_gmt: '2026-08-08T01:00:00',
          content: { raw: RAW },
        },
      }));

      expect(
        (await fetchRemotePost({ client, wpPostId: 4242 })).publishedAt,
      ).toBeNull();
    },
  );

  it('日時が壊れていれば null にする', async () => {
    const { client } = createClient(() => ({
      json: { status: 'publish', date_gmt: 'いつか', content: { raw: RAW } },
    }));

    expect(
      (await fetchRemotePost({ client, wpPostId: 4242 })).publishedAt,
    ).toBeNull();
  });
});

describe('isUserEdited', () => {
  it('ハッシュが一致すれば未編集', () => {
    expect(
      isUserEdited({ lastContentHash: HASH, remoteContentHash: HASH }),
    ).toBe(false);
  });

  it('一致しなければ編集されたとみなす', () => {
    expect(
      isUserEdited({ lastContentHash: HASH, remoteContentHash: 'ちがう' }),
    ).toBe(true);
  });
});

describe('syncPost', () => {
  it('前回書いた本文と同じなら未編集', async () => {
    const { client } = createClient();

    const result = await syncPost({
      client,
      wpPostId: 4242,
      lastContentHash: HASH,
    });

    expect(result.userEdited).toBe(false);
  });

  // DATA_MODEL 11章。**時刻ではなく本文で判定する**
  it('利用者が書き換えていれば検出する', async () => {
    const { client } = createClient(() => ({
      json: {
        status: 'draft',
        content: { raw: '<p>モニターが直した本文</p>' },
      },
    }));

    const result = await syncPost({
      client,
      wpPostId: 4242,
      lastContentHash: HASH,
    });

    expect(result.userEdited).toBe(true);
    expect(result.contentHash).toBe(contentHash('<p>モニターが直した本文</p>'));
  });
});
