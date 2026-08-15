import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  applyRichMenu,
  describeRichMenuState,
  readRichMenu,
  readRichMenuImage,
  removeRemoteRichMenu,
  saveRichMenu,
  saveRichMenuImage,
  type RichMenuInput,
} from '@/modules/line';
import type { RichMenuClient } from '@/lib/line/rich-menu';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * リッチメニュー（Q-054、TASKS H-6）を**実PostgreSQLで**確かめる。
 *
 * 見るのは2つ。
 *
 * 1. **DBが決まりを守らせている**か（アプリ側の書き方に依存させない）
 * 2. **適用が途中で失敗しても、いま出ているメニューを壊さない**か
 */

let prisma: PrismaClient;
let userId: string;

/** PNG の頭だけ（`IHDR` に縦横が入っている） */
function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ]);
}

function menu(overrides: Partial<RichMenuInput> = {}): RichMenuInput {
  return {
    name: 'BUNSHIN BLOG',
    chatBarText: 'メニュー',
    canvas: 'LARGE',
    selected: true,
    areas: [
      {
        x: 0,
        y: 0,
        width: 1250,
        height: 843,
        label: 'はじめの設定',
        uri: 'https://liff.line.me/1-a/liff/onboarding',
      },
      {
        x: 1250,
        y: 0,
        width: 1250,
        height: 843,
        label: '提案を見る',
        uri: 'https://liff.line.me/1-a/liff/approvals',
      },
    ],
    ...overrides,
  };
}

function fakeClient(overrides: Partial<RichMenuClient> = {}): RichMenuClient {
  return {
    create: vi.fn(async () => 'richmenu-new'),
    uploadImage: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => undefined),
    getDefault: vi.fn(async () => null),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** 画像まで入った、適用できる状態にする */
async function ready(): Promise<void> {
  await saveRichMenu(menu(), userId);
  await saveRichMenuImage(png(2500, 1686), userId);
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  userId = user.id;
});

describe('DBが決まりを守らせている', () => {
  /** **1行だけ。** 全モニター共通で、出し分けが Phase 0 に無い */
  it('2行目を入れられない', async () => {
    await saveRichMenu(menu(), userId);

    await expect(
      prisma.$executeRawUnsafe(
        `insert into rich_menus (id, singleton, name, chat_bar_text, updated_at)
         values (gen_random_uuid(), true, 'ふたつめ', 'メニュー', now())`,
      ),
    ).rejects.toThrow();
  });

  /** **14字を超えると LINE が断る。** DBでも止める */
  it('メニューバーの文字が長い行を入れられない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into rich_menus (id, name, chat_bar_text, updated_at)
         values (gen_random_uuid(), 'x', $1, now())`,
        'あ'.repeat(15),
      ),
    ).rejects.toThrow();
  });

  /** **大きさだけ残って中身が無い、を作らせない** */
  it('画像の列がそろっていない行を入れられない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into rich_menus (id, name, chat_bar_text, image_width, updated_at)
         values (gen_random_uuid(), 'x', 'メニュー', 2500, now())`,
      ),
    ).rejects.toThrow();
  });

  /** **出ていないのに出ていることになっている、を防ぐ** */
  it('適用の列がそろっていない行を入れられない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into rich_menus (id, name, chat_bar_text, line_rich_menu_id, updated_at)
         values (gen_random_uuid(), 'x', 'メニュー', 'richmenu-1', now())`,
      ),
    ).rejects.toThrow();
  });

  it('知らない画像の種類を入れられない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into rich_menus (id, name, chat_bar_text, image_data, image_mime_type, image_width, image_height, updated_at)
         values (gen_random_uuid(), 'x', 'メニュー', '\\x00'::bytea, 'image/gif', 2500, 1686, now())`,
      ),
    ).rejects.toThrow();
  });
});

describe('下書きを保存する', () => {
  it('読み直せる', async () => {
    await saveRichMenu(menu(), userId);

    const stored = await readRichMenu();

    expect(stored.name).toBe('BUNSHIN BLOG');
    expect(stored.areas).toHaveLength(2);
    expect(stored.areas[0]).toEqual({
      x: 0,
      y: 0,
      width: 1250,
      height: 843,
      label: 'はじめの設定',
      uri: 'https://liff.line.me/1-a/liff/onboarding',
    });
  });

  /** **保存だけでは LINE に出ない。** 適用と分ける */
  it('保存しただけでは未適用のまま', async () => {
    await saveRichMenu(menu(), userId);

    const stored = await readRichMenu();

    expect(stored.lineRichMenuId).toBeNull();
    expect(stored.appliedAt).toBeNull();
  });

  it('二度目は上書きになる（増えない）', async () => {
    await saveRichMenu(menu(), userId);
    await saveRichMenu(menu({ name: 'あたらしい' }), userId);

    expect((await readRichMenu()).name).toBe('あたらしい');
    expect(await prisma.richMenu.count()).toBe(1);
  });

  it('何も保存していなければ空の形を返す', async () => {
    const stored = await readRichMenu();

    expect(stored.areas).toEqual([]);
    expect(stored.hasImage).toBe(false);
  });
});

describe('画像を保存する', () => {
  it('大きさを覚えて、中身を読み直せる', async () => {
    await saveRichMenu(menu(), userId);
    await saveRichMenuImage(png(2500, 1686), userId);

    const stored = await readRichMenu();

    expect(stored).toMatchObject({
      hasImage: true,
      imageMimeType: 'image/png',
      imageWidth: 2500,
      imageHeight: 1686,
    });

    const image = await readRichMenuImage();

    expect(image?.mimeType).toBe('image/png');
    expect(image?.data.byteLength).toBeGreaterThan(0);
  });

  /**
   * **比が違うと、管理画面で見た升目と指で押す場所がずれる。**
   * LINE は画像を枠へ引き伸ばす。
   */
  it('枠と縦横比が違う画像を断る', async () => {
    await saveRichMenu(menu({ canvas: 'COMPACT' }), userId);

    await expect(saveRichMenuImage(png(2500, 1686), userId)).rejects.toThrow(
      /縦横比/,
    );
  });

  it('下書きが無くても画像から入れられる', async () => {
    await saveRichMenuImage(png(2500, 1686), userId);

    expect((await readRichMenu()).hasImage).toBe(true);
  });
});

describe('LINEへ出す', () => {
  it('作る→画像→既定、の順に呼ぶ', async () => {
    await ready();

    const order: string[] = [];
    const client = fakeClient({
      create: vi.fn(async () => {
        order.push('create');
        return 'richmenu-new';
      }),
      uploadImage: vi.fn(async () => {
        order.push('upload');
      }),
      setDefault: vi.fn(async () => {
        order.push('default');
      }),
    });

    const result = await applyRichMenu({ client }, userId);

    expect(order).toEqual(['create', 'upload', 'default']);
    expect(result.lineRichMenuId).toBe('richmenu-new');
    expect((await readRichMenu()).lineRichMenuId).toBe('richmenu-new');
    expect((await readRichMenu()).appliedAt).not.toBeNull();
  });

  it('画像が無ければ断る（LINEを触らない）', async () => {
    await saveRichMenu(menu(), userId);

    const client = fakeClient();

    await expect(applyRichMenu({ client }, userId)).rejects.toThrow(/画像/);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('押す場所が無ければ断る', async () => {
    await saveRichMenu(menu({ areas: [] }), userId);
    await saveRichMenuImage(png(2500, 1686), userId);

    const client = fakeClient();

    await expect(applyRichMenu({ client }, userId)).rejects.toThrow(/押す場所/);
    expect(client.create).not.toHaveBeenCalled();
  });

  /**
   * **途中で失敗したら、いま出ているものを壊さない。**
   * 作りかけも残さない。
   */
  it('画像の登録に失敗したら、作りかけを片づけて元のままにする', async () => {
    await ready();
    await applyRichMenu({ client: fakeClient() }, userId);

    const remove = vi.fn(async () => undefined);
    const failing = fakeClient({
      create: vi.fn(async () => 'richmenu-broken'),
      uploadImage: vi.fn(async () => {
        throw new Error('だめ');
      }),
      remove,
    });

    await expect(applyRichMenu({ client: failing }, userId)).rejects.toThrow();

    // 作りかけだけを消している
    expect(remove).toHaveBeenCalledWith('richmenu-broken');
    expect(remove).toHaveBeenCalledTimes(1);

    // **既定は差し替えていない**
    expect(failing.setDefault).not.toHaveBeenCalled();
    expect((await readRichMenu()).lineRichMenuId).toBe('richmenu-new');
  });

  it('既定の差し替えに失敗しても、保存してある適用先を書き換えない', async () => {
    await ready();
    await applyRichMenu({ client: fakeClient() }, userId);

    const failing = fakeClient({
      create: vi.fn(async () => 'richmenu-broken'),
      setDefault: vi.fn(async () => {
        throw new Error('だめ');
      }),
    });

    await expect(applyRichMenu({ client: failing }, userId)).rejects.toThrow();
    expect((await readRichMenu()).lineRichMenuId).toBe('richmenu-new');
  });

  /** **古いものは既定を差し替えた後で消す。** 先に消すと誰にも出なくなる */
  it('前のメニューを、既定を差し替えた後に消す', async () => {
    await ready();
    await applyRichMenu(
      { client: fakeClient({ create: vi.fn(async () => 'richmenu-old') }) },
      userId,
    );

    const order: string[] = [];
    const client = fakeClient({
      create: vi.fn(async () => 'richmenu-new'),
      setDefault: vi.fn(async () => {
        order.push('default');
      }),
      remove: vi.fn(async (id: string) => {
        order.push(`remove:${id}`);
      }),
    });

    await applyRichMenu({ client }, userId);

    expect(order).toEqual(['default', 'remove:richmenu-old']);
  });

  /** **消せなくても適用は成った。** 画面に出して人に片づけさせる */
  it('前のメニューを消せなければ、片づけ残りとして返す', async () => {
    await ready();
    await applyRichMenu(
      { client: fakeClient({ create: vi.fn(async () => 'richmenu-old') }) },
      userId,
    );

    const client = fakeClient({
      remove: vi.fn(async () => {
        throw new Error('消せない');
      }),
    });

    const result = await applyRichMenu({ client }, userId);

    expect(result.lineRichMenuId).toBe('richmenu-new');
    expect(result.staleRichMenuId).toBe('richmenu-old');
    expect((await readRichMenu()).lineRichMenuId).toBe('richmenu-new');
  });
});

describe('いま出ているものを確かめる', () => {
  /** **保存した値ではなく LINE に聞く**（段6の「接続をためす」と同じ） */
  it('LINEの既定と一致していれば applied', async () => {
    await ready();
    await applyRichMenu({ client: fakeClient() }, userId);

    const state = await describeRichMenuState({
      client: fakeClient({ getDefault: vi.fn(async () => 'richmenu-new') }),
    });

    expect(state.applied).toBe(true);
    expect(state.defaultRichMenuId).toBe('richmenu-new');
  });

  it('LINE側で差し替えられていたら applied にしない', async () => {
    await ready();
    await applyRichMenu({ client: fakeClient() }, userId);

    const state = await describeRichMenuState({
      client: fakeClient({ getDefault: vi.fn(async () => 'richmenu-other') }),
    });

    expect(state.applied).toBe(false);
  });

  it('一度も出していなければ applied にしない', async () => {
    await ready();

    const state = await describeRichMenuState({ client: fakeClient() });

    expect(state.applied).toBe(false);
    expect(state.defaultRichMenuId).toBeNull();
  });
});

describe('片づける', () => {
  /** **いま出ているものを消させない。** 消すと誰にもメニューが出なくなる */
  it('適用中のメニューは消せない', async () => {
    await ready();
    await applyRichMenu({ client: fakeClient() }, userId);

    const client = fakeClient();

    await expect(
      removeRemoteRichMenu({ client }, 'richmenu-new'),
    ).rejects.toThrow(/いま出ている/);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('使っていないメニューは消せる', async () => {
    await ready();
    await applyRichMenu({ client: fakeClient() }, userId);

    const client = fakeClient();

    await removeRemoteRichMenu({ client }, 'richmenu-stale');

    expect(client.remove).toHaveBeenCalledWith('richmenu-stale');
  });
});
