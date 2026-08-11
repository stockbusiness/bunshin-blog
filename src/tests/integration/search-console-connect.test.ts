import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ANALYTICS_ERROR_CODES,
  connectSearchConsoleForUser,
  disconnectSearchConsoleForUser,
  findSearchConsoleConnectionForUser,
  readServiceAccountEmail,
  testSearchConsoleForUser,
} from '@/modules/analytics';
import { saveSettingForAdmin } from '@/modules/settings';
import {
  GoogleNotConfiguredError,
  createSearchConsoleClient,
} from '@/lib/google';
import { Secret } from '@/lib/crypto';
import { BLOG_ERROR_CODES } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * Search Console の連携を**実PostgreSQLと実HTTPサーバーで**確かめる
 * （TASKS G-1、SPEC 11.3、OPEN_QUESTIONS Q-030）。
 *
 * 完了条件は「**ブログ単位で連携でき、トークンが暗号化される**」。
 *
 * ## 連携を「保存できた」で終わりにしない
 *
 * モニターが Search Console 側でアドレスを追加していなければ、
 * URLを保存しただけでは何も取れない。**保存と同時に問い合わせ、
 * 読めたかどうかを `connection_status` に残す。**
 * ここが `CONNECTED` にならないまま「連携済み」と見えると、
 * G-2 が動き出すまで誰も気づけない。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

let server: Server;
let port: number;

const OK = 'sc-domain:ok.example.com';
const NOT_SHARED = 'sc-domain:missing.example.com';
const UNVERIFIED = 'sc-domain:unverified.example.com';
const DOWN = 'sc-domain:down.example.com';

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const siteUrl = decodeURIComponent(url.pathname.slice('/sites/'.length));

    if (siteUrl === NOT_SHARED) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    if (siteUrl === UNVERIFIED) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ siteUrl, permissionLevel: 'siteUnverifiedUser' }),
      );
      return;
    }

    if (siteUrl === DOWN) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ siteUrl, permissionLevel: 'siteOwner' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('サーバーのアドレスを取得できません');
  }

  port = address.port;
});

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

/** 実HTTPを叩くクライアント。**鍵の取得だけを差し替える** */
function client() {
  return createSearchConsoleClient(
    {
      token: new Secret('access-token'),
      expiresAt: new Date(Date.now() + 1e6),
    },
    { baseUrl: `http://127.0.0.1:${port}` },
  );
}

beforeEach(async () => {
  await resetDatabase(prisma);

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, userId);
  blogId = blog.id;
});

describe('ブログ単位で連携できる（完了条件）', () => {
  it('プロパティを結びつけて CONNECTED になる', async () => {
    const result = await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: OK },
      { client: client() },
    );

    expect(result.connection).toMatchObject({
      blogId,
      propertyUrl: OK,
      connectionStatus: 'CONNECTED',
      lastErrorCode: null,
    });
    expect(result.check).toEqual({
      status: 'CONNECTED',
      permissionLevel: 'siteOwner',
    });
  });

  it('1ブログに1行しか作らない', async () => {
    await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: OK },
      { client: client() },
    );
    await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: 'sc-domain:other.example.com' },
      { client: client() },
    );

    const rows = await prisma.searchConsoleConnection.findMany({
      where: { blogId },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.propertyUrl).toBe('sc-domain:other.example.com');
  });

  /** **ブログごとに別のプロパティを見る**（3ブログ運用・SPEC 1.2） */
  it('ブログごとに別のプロパティを持てる', async () => {
    const other = await createBlog(prisma, userId, { slotNumber: 2 });

    await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: OK },
      { client: client() },
    );
    await connectSearchConsoleForUser(
      { userId, blogId: other.id, propertyUrl: 'sc-domain:two.example.com' },
      { client: client() },
    );

    expect(
      (await findSearchConsoleConnectionForUser({ userId, blogId }))
        ?.propertyUrl,
    ).toBe(OK);
    expect(
      (await findSearchConsoleConnectionForUser({ userId, blogId: other.id }))
        ?.propertyUrl,
    ).toBe('sc-domain:two.example.com');
  });

  it('URLプレフィックスは末尾のスラッシュを補って保存する', async () => {
    const result = await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: 'https://blog.example.com' },
      { client: client() },
    );

    expect(result.connection.propertyUrl).toBe('https://blog.example.com/');
  });

  it('形が違うURLは保存しない', async () => {
    await expect(
      connectSearchConsoleForUser(
        { userId, blogId, propertyUrl: 'example.com' },
        { client: client() },
      ),
    ).rejects.toMatchObject({
      code: ANALYTICS_ERROR_CODES.invalidPropertyUrl,
    });

    expect(await prisma.searchConsoleConnection.count()).toBe(0);
  });
});

describe('読めなかったことを残す', () => {
  /**
   * **保存はする。** モニターが先にURLを入れ、あとから Search Console 側で
   * 権限を渡す順序がありうる。やり直せるように行は残す
   */
  it('共有されていなければ FAILED として残す', async () => {
    const result = await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: NOT_SHARED },
      { client: client() },
    );

    expect(result.connection).toMatchObject({
      connectionStatus: 'FAILED',
      lastErrorCode: 'NOT_SHARED',
      propertyUrl: NOT_SHARED,
    });
  });

  /** **所有確認が済んでいないのは別扱い。** モニターに頼むことが違う */
  it('所有確認が済んでいなければ UNVERIFIED として残す', async () => {
    const result = await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: UNVERIFIED },
      { client: client() },
    );

    expect(result.connection).toMatchObject({
      connectionStatus: 'FAILED',
      lastErrorCode: 'UNVERIFIED',
    });
  });

  /**
   * **Google側の一時的な失敗を `FAILED` にしない**（H-3 と同じ筋）。
   * 設定は正しいかもしれず、「つながっていません」と出すと直せない指摘になる
   */
  it('Google が落ちていたら UNTESTED のまま', async () => {
    const result = await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: DOWN },
      { client: client() },
    );

    expect(result.connection).toMatchObject({
      connectionStatus: 'UNTESTED',
      lastErrorCode: 'UNAVAILABLE',
    });
  });
});

describe('確かめ直す', () => {
  it('直ったら CONNECTED になり、理由が消える', async () => {
    await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: NOT_SHARED },
      { client: client() },
    );

    // 権限が渡されたあとを模す（同じURLが読めるサーバーへ）
    await prisma.searchConsoleConnection.update({
      where: { blogId },
      data: { propertyUrl: OK },
    });

    const result = await testSearchConsoleForUser(
      { userId, blogId },
      { client: client() },
    );

    expect(result.connection).toMatchObject({
      connectionStatus: 'CONNECTED',
      // **直ったら消える。** 残っていると直った後も出続ける
      lastErrorCode: null,
    });
  });

  /** **URLは変えない。** 変えたいなら connect を呼ぶ */
  it('プロパティのURLは変わらない', async () => {
    await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: OK },
      { client: client() },
    );

    const result = await testSearchConsoleForUser(
      { userId, blogId },
      { client: client() },
    );

    expect(result.connection.propertyUrl).toBe(OK);
  });

  it('未連携のブログは 404', async () => {
    await expect(
      testSearchConsoleForUser({ userId, blogId }, { client: client() }),
    ).rejects.toMatchObject({
      code: ANALYTICS_ERROR_CODES.searchConsoleNotConnected,
    });
  });
});

describe('外す', () => {
  /**
   * **行ごと消す。** WordPress（`REVOKED` で `site_url` を残す・Q-007）と違い、
   * 同じブログで別のプロパティに繋ぎ直すのは誤りではない
   */
  it('行が消え、繋ぎ直せる', async () => {
    await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: OK },
      { client: client() },
    );

    await disconnectSearchConsoleForUser({ userId, blogId });

    expect(
      await findSearchConsoleConnectionForUser({ userId, blogId }),
    ).toBeNull();

    const again = await connectSearchConsoleForUser(
      { userId, blogId, propertyUrl: 'sc-domain:two.example.com' },
      { client: client() },
    );

    expect(again.connection.connectionStatus).toBe('CONNECTED');
  });

  /** 連携していなくても失敗させない（押し直しても同じ結果） */
  it('未連携でも失敗しない', async () => {
    await expect(
      disconnectSearchConsoleForUser({ userId, blogId }),
    ).resolves.toBeUndefined();
  });
});

describe('他人のブログ', () => {
  it('連携を読めない', async () => {
    const other = await createUser(prisma);

    await expect(
      findSearchConsoleConnectionForUser({ userId: other.id, blogId }),
    ).rejects.toMatchObject({ code: BLOG_ERROR_CODES.notFound });
  });
});

/**
 * **鍵が暗号化されること**（完了条件「トークンが暗号化される」）。
 *
 * Q-030 でサービスアカウントを採ったため、暗号化されるのは
 * ブログごとのトークンではなく**鍵1つ**になる。
 */
describe('サービスアカウントの鍵', () => {
  const KEY_JSON = JSON.stringify({
    type: 'service_account',
    client_email: 'bunshin@example-project.iam.gserviceaccount.com',
    private_key:
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  });

  it('暗号化列にだけ入り、平文の列は空のまま', async () => {
    await saveSettingForAdmin({
      key: 'GOOGLE_SERVICE_ACCOUNT_KEY',
      value: KEY_JSON,
      actorUserId: null,
    });

    const row = await prisma.appSetting.findUnique({
      where: { key: 'GOOGLE_SERVICE_ACCOUNT_KEY' },
    });

    expect(row?.value).toBeNull();
    expect(row?.isSecret).toBe(true);
    // **鍵の中身がそのまま入っていないこと**
    expect(row?.valueEncrypted).not.toBeNull();
    expect(row?.valueEncrypted).not.toContain('BEGIN PRIVATE KEY');
  });

  /**
   * **アドレスは秘密ではない。** モニターに渡さなければ連携が始まらない。
   * 取り出すのはこの1項目だけで、`private_key` は返さない（SPEC 14.2）
   */
  it('鍵からアドレスだけを取り出せる', async () => {
    await saveSettingForAdmin({
      key: 'GOOGLE_SERVICE_ACCOUNT_KEY',
      value: KEY_JSON,
      actorUserId: null,
    });

    const email = await readServiceAccountEmail();

    expect(email).toBe('bunshin@example-project.iam.gserviceaccount.com');
    expect(email).not.toContain('BEGIN');
  });

  it('未設定なら足りない名前を告げる', async () => {
    await expect(readServiceAccountEmail()).rejects.toThrow(
      GoogleNotConfiguredError,
    );
  });

  /** **形の違う鍵は保存させない。** 保存できてから失敗するより早く分かる */
  it.each([
    { label: 'JSONでない', value: 'not json' },
    {
      label: 'client_email が無い',
      value: JSON.stringify({ private_key: '-----BEGIN X-----' }),
    },
    {
      label: 'private_key がPEMでない',
      value: JSON.stringify({
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: 'x',
      }),
    },
  ])('$label は保存を拒む', async ({ value }) => {
    await expect(
      saveSettingForAdmin({
        key: 'GOOGLE_SERVICE_ACCOUNT_KEY',
        value,
        actorUserId: null,
      }),
    ).rejects.toThrow();
  });
});
