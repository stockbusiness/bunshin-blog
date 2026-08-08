import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  ENCRYPTION_KEY_BYTES,
  decryptSecret,
  encryptSecret,
  isEncryptedPayload,
} from '@/lib/crypto';
import {
  WORDPRESS_ERROR_CODES,
  connectWordpress,
  credentialAad,
  disconnectWordpress,
  readWordpressCredentials,
  type StoredWordpressConnection,
  type WordpressConnectionDb,
  type WordpressConnectionWrite,
  type WordpressDeps,
  type WordpressSecretCipher,
} from '@/modules/wordpress';

/**
 * 接続情報の保存（TASKS C-1）。
 *
 * DBは fake、暗号化は本物を使う。**「暗号化されたことにした」テストにしない**
 * ため。所有権の検証は `repository.ts` の担当で、統合テストで確かめる。
 */

const KEY = randomBytes(ENCRYPTION_KEY_BYTES);
const BLOG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_BLOG_ID = '22222222-2222-2222-2222-222222222222';

const cipher: WordpressSecretCipher = {
  encrypt: (plaintext, aad) => encryptSecret(plaintext, { key: KEY, aad }),
  decrypt: (payload, aad) => decryptSecret(payload, { key: KEY, aad }),
};

/** 行を1件だけ持つ fake。実際のDBと同じく `blogId` で一意 */
function createFakeDb(): WordpressConnectionDb & {
  rows: Map<string, StoredWordpressConnection>;
} {
  const rows = new Map<string, StoredWordpressConnection>();
  let sequence = 0;

  return {
    rows,

    async findByBlogId(blogId) {
      const found = rows.get(blogId);
      // 参照をそのまま返すと、呼び出し側の変更が fake に反映されてしまう
      return found === undefined ? null : { ...found };
    },

    async create(blogId, data) {
      sequence += 1;
      const row: StoredWordpressConnection = {
        id: `conn-${sequence}`,
        blogId,
        lastSyncedAt: null,
        createdAt: new Date('2026-08-07T00:00:00Z'),
        updatedAt: new Date('2026-08-07T00:00:00Z'),
        ...data,
      };
      rows.set(blogId, row);
      return { ...row };
    },

    async update(blogId, data: Partial<WordpressConnectionWrite>) {
      const current = rows.get(blogId);
      if (current === undefined) {
        throw new Error(`行がありません: ${blogId}`);
      }
      const row: StoredWordpressConnection = {
        ...current,
        ...data,
        updatedAt: new Date('2026-08-08T00:00:00Z'),
      };
      rows.set(blogId, row);
      return { ...row };
    },
  };
}

let db: ReturnType<typeof createFakeDb>;
let deps: WordpressDeps;

beforeEach(() => {
  db = createFakeDb();
  deps = { db, cipher };
});

const INPUT = {
  siteUrl: 'https://example.com/',
  wpUsername: 'monitor01',
  appPassword: 'abcd EFGH ijkl MNOP qrst UVWX',
};

describe('connectWordpress（新規接続）', () => {
  it('正規化した site_url と REST ベースを保存する', async () => {
    const connection = await connectWordpress(
      { blogId: BLOG_ID, input: INPUT },
      deps,
    );

    expect(connection.siteUrl).toBe('https://example.com');
    expect(connection.apiBaseUrl).toBe('https://example.com/wp-json');
  });

  it('保存直後は UNTESTED で、権限は全て false（SPEC 7.2 は C-2）', async () => {
    const connection = await connectWordpress(
      { blogId: BLOG_ID, input: INPUT },
      deps,
    );

    expect(connection.connectionStatus).toBe('UNTESTED');
    expect(connection.canCreatePosts).toBe(false);
    expect(connection.canEditPosts).toBe(false);
    expect(connection.canUploadMedia).toBe(false);
    expect(connection.lastTestedAt).toBeNull();
  });

  it('認証情報を暗号化して保存する（平文で入らない）', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);
    const row = db.rows.get(BLOG_ID);

    expect(isEncryptedPayload(row?.wpUsernameEncrypted ?? '')).toBe(true);
    expect(isEncryptedPayload(row?.appPasswordEncrypted ?? '')).toBe(true);
    expect(JSON.stringify(row)).not.toContain('monitor01');
    expect(JSON.stringify(row)).not.toContain('abcdEFGH');
    expect(JSON.stringify(row)).not.toContain('abcd EFGH');
  });

  it('アプリケーションパスワードの空白を取り除いて保存する', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);

    const credentials = await readWordpressCredentials(
      { blogId: BLOG_ID },
      deps,
    );

    expect(credentials.appPassword.expose()).toBe('abcdEFGHijklMNOPqrstUVWX');
  });

  it('ユーザー名の前後の空白を落として保存する', async () => {
    await connectWordpress(
      { blogId: BLOG_ID, input: { ...INPUT, wpUsername: '  monitor01  ' } },
      deps,
    );

    const credentials = await readWordpressCredentials(
      { blogId: BLOG_ID },
      deps,
    );

    expect(credentials.username.expose()).toBe('monitor01');
  });

  it('戻り値に暗号文も復号値も含めない（SPEC 5.4）', async () => {
    const connection = await connectWordpress(
      { blogId: BLOG_ID, input: INPUT },
      deps,
    );

    const serialized = JSON.stringify(connection);
    expect(serialized).not.toContain('monitor01');
    expect(serialized).not.toContain('abcdEFGH');
    expect(serialized).not.toContain('Encrypted');
    expect(Object.keys(connection)).not.toContain('wpUsernameEncrypted');
    expect(Object.keys(connection)).not.toContain('appPasswordEncrypted');
    expect(connection.hasCredentials).toBe(true);
  });

  it('暗号文はブログと列に結び付いており、別の行へ移せない', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);
    const row = db.rows.get(BLOG_ID);

    // 他人の行へ暗号文をコピーしても復号できない
    expect(() =>
      cipher.decrypt(
        row?.appPasswordEncrypted ?? '',
        credentialAad(OTHER_BLOG_ID, 'app_password'),
      ),
    ).toThrow();

    // 列を入れ替えても復号できない
    expect(() =>
      cipher.decrypt(
        row?.appPasswordEncrypted ?? '',
        credentialAad(BLOG_ID, 'wp_username'),
      ),
    ).toThrow();
  });

  it.each([
    ['ユーザー名が空', { wpUsername: '   ' }],
    ['パスワードが空', { appPassword: '  ' }],
    ['ユーザー名が長すぎる', { wpUsername: 'a'.repeat(101) }],
    ['パスワードが長すぎる', { appPassword: 'a'.repeat(201) }],
  ])('入力を検証する（%s）', async (_label, overrides) => {
    await expect(
      connectWordpress(
        { blogId: BLOG_ID, input: { ...INPUT, ...overrides } },
        deps,
      ),
    ).rejects.toThrow(AppError);

    expect(db.rows.size).toBe(0);
  });

  it('入力エラーのメッセージにパスワードを含めない', async () => {
    await expect(
      connectWordpress(
        { blogId: BLOG_ID, input: { ...INPUT, wpUsername: '' } },
        deps,
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('abcd'),
      }),
    );
  });

  it('site_url が不正なら保存しない', async () => {
    await expect(
      connectWordpress(
        { blogId: BLOG_ID, input: { ...INPUT, siteUrl: 'http://example.com' } },
        deps,
      ),
    ).rejects.toThrow(AppError);

    expect(db.rows.size).toBe(0);
  });
});

describe('connectWordpress（再接続・OPEN_QUESTIONS Q-007）', () => {
  beforeEach(async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);
  });

  it('同一URLなら認証情報を入れ替えられる', async () => {
    await connectWordpress(
      {
        blogId: BLOG_ID,
        input: { ...INPUT, appPassword: 'NEWPASSWORD1234567890abc' },
      },
      deps,
    );

    const credentials = await readWordpressCredentials(
      { blogId: BLOG_ID },
      deps,
    );

    expect(credentials.appPassword.expose()).toBe('NEWPASSWORD1234567890abc');
    expect(db.rows.size).toBe(1);
  });

  it('表記が違っても正規化後に同じなら再接続できる', async () => {
    await expect(
      connectWordpress(
        {
          blogId: BLOG_ID,
          input: { ...INPUT, siteUrl: 'HTTPS://Example.com' },
        },
        deps,
      ),
    ).resolves.toMatchObject({ siteUrl: 'https://example.com' });
  });

  it('別サイトへの変更は 409 で拒否する', async () => {
    await expect(
      connectWordpress(
        { blogId: BLOG_ID, input: { ...INPUT, siteUrl: 'https://other.com' } },
        deps,
      ),
    ).rejects.toMatchObject({
      code: WORDPRESS_ERROR_CODES.siteUrlImmutable,
      status: 409,
    });
  });

  it('拒否された場合、保存済みの認証情報は変わらない', async () => {
    const before = db.rows.get(BLOG_ID)?.appPasswordEncrypted;

    await expect(
      connectWordpress(
        {
          blogId: BLOG_ID,
          input: {
            siteUrl: 'https://other.com',
            wpUsername: 'attacker',
            appPassword: 'attackerpassword1234',
          },
        },
        deps,
      ),
    ).rejects.toThrow(AppError);

    expect(db.rows.get(BLOG_ID)?.appPasswordEncrypted).toBe(before);
    expect(db.rows.get(BLOG_ID)?.siteUrl).toBe('https://example.com');
  });

  it('再接続でテスト結果と権限を初期化する', async () => {
    await db.update(BLOG_ID, {
      connectionStatus: 'CONNECTED',
      canCreatePosts: true,
      canEditPosts: true,
      canUploadMedia: true,
      lastTestedAt: new Date('2026-08-07T12:00:00Z'),
      lastErrorCode: 'PREVIOUS',
      lastErrorMessage: '前回の失敗',
    });

    const connection = await connectWordpress(
      { blogId: BLOG_ID, input: INPUT },
      deps,
    );

    expect(connection.connectionStatus).toBe('UNTESTED');
    expect(connection.canCreatePosts).toBe(false);
    expect(connection.canEditPosts).toBe(false);
    expect(connection.canUploadMedia).toBe(false);
    expect(connection.lastTestedAt).toBeNull();
    expect(connection.lastErrorCode).toBeNull();
    expect(connection.lastErrorMessage).toBeNull();
  });
});

describe('disconnectWordpress', () => {
  beforeEach(async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);
  });

  it('行を消さずに REVOKED にする', async () => {
    const connection = await disconnectWordpress({ blogId: BLOG_ID }, deps);

    expect(connection.connectionStatus).toBe('REVOKED');
    expect(db.rows.size).toBe(1);
  });

  it('site_url を保持する（Q-007 の再接続時の照合に使う）', async () => {
    await disconnectWordpress({ blogId: BLOG_ID }, deps);

    expect(db.rows.get(BLOG_ID)?.siteUrl).toBe('https://example.com');
  });

  it('認証情報を空で上書きする', async () => {
    await disconnectWordpress({ blogId: BLOG_ID }, deps);
    const row = db.rows.get(BLOG_ID);

    expect(
      cipher
        .decrypt(
          row?.appPasswordEncrypted ?? '',
          credentialAad(BLOG_ID, 'app_password'),
        )
        .expose(),
    ).toBe('');
    expect(
      cipher
        .decrypt(
          row?.wpUsernameEncrypted ?? '',
          credentialAad(BLOG_ID, 'wp_username'),
        )
        .expose(),
    ).toBe('');
  });

  it('切断後は hasCredentials が false になる', async () => {
    const connection = await disconnectWordpress({ blogId: BLOG_ID }, deps);

    expect(connection.hasCredentials).toBe(false);
  });

  it('権限を全て false に戻す', async () => {
    await db.update(BLOG_ID, {
      canCreatePosts: true,
      canEditPosts: true,
      canUploadMedia: true,
    });

    const connection = await disconnectWordpress({ blogId: BLOG_ID }, deps);

    expect(connection.canCreatePosts).toBe(false);
    expect(connection.canEditPosts).toBe(false);
    expect(connection.canUploadMedia).toBe(false);
  });

  it('切断後も同一URLで再接続できる', async () => {
    await disconnectWordpress({ blogId: BLOG_ID }, deps);

    const connection = await connectWordpress(
      { blogId: BLOG_ID, input: INPUT },
      deps,
    );

    expect(connection.connectionStatus).toBe('UNTESTED');
    expect(connection.hasCredentials).toBe(true);
  });

  it('切断後に別サイトへ繋ぎ直すことはできない（Q-007）', async () => {
    await disconnectWordpress({ blogId: BLOG_ID }, deps);

    await expect(
      connectWordpress(
        { blogId: BLOG_ID, input: { ...INPUT, siteUrl: 'https://other.com' } },
        deps,
      ),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.siteUrlImmutable });
  });

  it('未接続なら 404', async () => {
    await expect(
      disconnectWordpress({ blogId: OTHER_BLOG_ID }, deps),
    ).rejects.toMatchObject({
      code: WORDPRESS_ERROR_CODES.notConnected,
      status: 404,
    });
  });
});

describe('readWordpressCredentials', () => {
  it('保存した認証情報を Secret として返す', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);

    const credentials = await readWordpressCredentials(
      { blogId: BLOG_ID },
      deps,
    );

    expect(credentials.username.expose()).toBe('monitor01');
    expect(JSON.stringify(credentials)).not.toContain('monitor01');
    expect(JSON.stringify(credentials)).toBe(
      '{"username":"[REDACTED]","appPassword":"[REDACTED]"}',
    );
  });

  it('未接続なら 404', async () => {
    await expect(
      readWordpressCredentials({ blogId: BLOG_ID }, deps),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.notConnected });
  });

  it('切断済みなら 404', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);
    await disconnectWordpress({ blogId: BLOG_ID }, deps);

    await expect(
      readWordpressCredentials({ blogId: BLOG_ID }, deps),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.notConnected });
  });

  it('REVOKED でなくとも中身が空なら 404（想定外の状態への保険）', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);
    await db.update(BLOG_ID, {
      appPasswordEncrypted: cipher.encrypt(
        '',
        credentialAad(BLOG_ID, 'app_password'),
      ),
    });

    await expect(
      readWordpressCredentials({ blogId: BLOG_ID }, deps),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.notConnected });
  });

  it('復号できない場合は 500 にし、理由をクライアントへ返さない', async () => {
    await connectWordpress({ blogId: BLOG_ID, input: INPUT }, deps);

    const otherKey = randomBytes(ENCRYPTION_KEY_BYTES);
    const brokenDeps: WordpressDeps = {
      db,
      cipher: {
        encrypt: cipher.encrypt,
        decrypt: (payload, aad) =>
          decryptSecret(payload, { key: otherKey, aad }),
      },
    };

    await expect(
      readWordpressCredentials({ blogId: BLOG_ID }, brokenDeps),
    ).rejects.toMatchObject({
      code: WORDPRESS_ERROR_CODES.credentialsUnreadable,
      status: 500,
      message: '保存された認証情報を読み出せませんでした。接続し直してください',
    });
  });
});
