import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  PROMPT_ERROR_CODES,
  activatePromptVersionForAdmin,
  createPromptVersionForAdmin,
  deactivatePromptForAdmin,
  findActivePrompt,
  findPromptVersionForAdmin,
  listPromptVersionsForAdmin,
  requireActivePrompt,
} from '@/modules/content-generation';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * プロンプトの版を**実PostgreSQLで**確かめる（TASKS E-2、SPEC 6.2）。
 *
 * 完了条件は「**プロンプトの有効化・ロールバックができる**」。
 *
 * 中心は「**1つの `key` に有効な版は1つまで**」で、これは**同時に別々の版を
 * 有効化したときにも崩れてはいけない**。差し替えでは確かめられない。
 */

let prisma: PrismaClient;

async function create(
  version: string,
  options: { key?: string; activate?: boolean } = {},
): Promise<void> {
  await createPromptVersionForAdmin({
    key: options.key ?? 'article.body',
    version,
    body: `本文 ${version}`,
    ...(options.activate === undefined ? {} : { activate: options.activate }),
  });
}

/**
 * `created_at` を明示的に置く。
 *
 * **並び順の確認を「作った速さ」に依存させないため。** `created_at` は
 * ミリ秒までしか持たないので、続けて作ると同じ値になることがある。
 */
async function stampCreatedAt(version: string, iso: string): Promise<void> {
  await prisma.promptVersion.updateMany({
    where: { key: 'article.body', version },
    data: { createdAt: new Date(iso) },
  });
}

async function activeVersion(key = 'article.body'): Promise<string | null> {
  return (await findActivePrompt(key))?.version ?? null;
}

async function activeCount(key = 'article.body'): Promise<number> {
  return prisma.promptVersion.count({ where: { key, isActive: true } });
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
});

describe('版の作成', () => {
  it('作った直後は無効', async () => {
    await create('v1');

    expect(await activeVersion()).toBeNull();
    expect(
      (await findPromptVersionForAdmin({ key: 'article.body', version: 'v1' }))
        ?.isActive,
    ).toBe(false);
  });

  it('作ると同時に有効化できる', async () => {
    await create('v1', { activate: true });

    expect(await activeVersion()).toBe('v1');
  });

  /**
   * **版は「どのプロンプトで生成したか」を辿るための記録。**
   * 中身が変わると、過去の記事の生成条件が分からなくなる。
   */
  it('同じ版を上書きできない', async () => {
    await create('v1');

    await expect(create('v1')).rejects.toMatchObject({
      code: PROMPT_ERROR_CODES.duplicateVersion,
      status: 409,
    });

    expect(await prisma.promptVersion.count()).toBe(1);
  });

  it('種類が違えば同じ版名を使える', async () => {
    await create('v1');
    await create('v1', { key: 'article.faq' });

    expect(await prisma.promptVersion.count()).toBe(2);
  });

  it('一覧は新しい順', async () => {
    await create('v1');
    await create('v2');
    await create('v3');

    // **作った間隔に頼らない。** `created_at` はミリ秒までしか持たず、
    // 続けて作ると同じ値になりうる（CIで実際に落ちた）。並び順を
    // 確かめたいので、確かめる対象の時刻を明示的に離す
    await stampCreatedAt('v1', '2026-08-01T00:00:00.000Z');
    await stampCreatedAt('v2', '2026-08-02T00:00:00.000Z');
    await stampCreatedAt('v3', '2026-08-03T00:00:00.000Z');

    const list = await listPromptVersionsForAdmin('article.body');

    expect(list.map((prompt) => prompt.version)).toEqual(['v3', 'v2', 'v1']);
  });

  /**
   * **同じミリ秒に作られた版の前後は決められない。** それでも一覧が
   * 呼ぶたびに入れ替わってはいけない（`/admin/prompts` を開き直すたびに
   * 並びが変わる）。`id` を最後の決め手にしてある。
   */
  it('時刻が同じ版でも並びは毎回同じ', async () => {
    await create('v1');
    await create('v2');
    await create('v3');

    await prisma.promptVersion.updateMany({
      where: { key: 'article.body' },
      data: { createdAt: new Date('2026-08-01T00:00:00.000Z') },
    });

    const first = await listPromptVersionsForAdmin('article.body');
    const second = await listPromptVersionsForAdmin('article.body');

    expect(first).toHaveLength(3);
    expect(second.map((prompt) => prompt.version)).toEqual(
      first.map((prompt) => prompt.version),
    );
  });
});

describe('有効化とロールバック（完了条件）', () => {
  beforeEach(async () => {
    await create('v1', { activate: true });
    await create('v2');
    await create('v3');
  });

  it('新しい版を有効にできる', async () => {
    await activatePromptVersionForAdmin({ key: 'article.body', version: 'v3' });

    expect(await activeVersion()).toBe('v3');
    expect(await activeCount()).toBe(1);
  });

  /** **ロールバックも同じ関数。** 過去の版を指定して呼べば戻る */
  it('過去の版へ戻せる', async () => {
    await activatePromptVersionForAdmin({ key: 'article.body', version: 'v3' });
    await activatePromptVersionForAdmin({ key: 'article.body', version: 'v1' });

    expect(await activeVersion()).toBe('v1');
    expect(await activeCount()).toBe(1);
  });

  it('同じ版を2回有効にしても壊れない', async () => {
    await activatePromptVersionForAdmin({ key: 'article.body', version: 'v2' });
    await activatePromptVersionForAdmin({ key: 'article.body', version: 'v2' });

    expect(await activeVersion()).toBe('v2');
    expect(await activeCount()).toBe(1);
  });

  /**
   * **これが1文のUPDATEにした理由。** 「他を無効にしてから有効にする」を
   * 2文に分けると、同時に別々の版を有効化したときに2つ有効な状態が残りうる。
   */
  it('同時に別々の版を有効化しても、有効は常に1つ', async () => {
    await Promise.all([
      activatePromptVersionForAdmin({ key: 'article.body', version: 'v1' }),
      activatePromptVersionForAdmin({ key: 'article.body', version: 'v2' }),
      activatePromptVersionForAdmin({ key: 'article.body', version: 'v3' }),
    ]);

    expect(await activeCount()).toBe(1);
    expect(await activeVersion()).not.toBeNull();
  });

  it('他の種類に影響しない', async () => {
    await create('v1', { key: 'article.faq', activate: true });

    await activatePromptVersionForAdmin({ key: 'article.body', version: 'v3' });

    expect(await activeVersion('article.faq')).toBe('v1');
  });

  it('無い版は有効にできない', async () => {
    await expect(
      activatePromptVersionForAdmin({ key: 'article.body', version: 'v9' }),
    ).rejects.toMatchObject({
      code: PROMPT_ERROR_CODES.notFound,
      status: 404,
    });

    // 元の有効な版は変わらない
    expect(await activeVersion()).toBe('v1');
  });
});

describe('記事生成が引くとき', () => {
  /**
   * **「いちばん新しい版」ではない。** 新しい版を作っただけで生成の挙動が
   * 変わってしまうと、試すことができない。
   */
  it('新しい版を作っても有効な版は変わらない', async () => {
    await create('v1', { activate: true });
    await create('v2');

    expect((await requireActivePrompt('article.body')).version).toBe('v1');
  });

  /** 版が決まらないまま生成すると、何で作った記事か記録できない */
  it('有効な版が無ければ落とす', async () => {
    await create('v1');

    await expect(requireActivePrompt('article.body')).rejects.toMatchObject({
      code: PROMPT_ERROR_CODES.noActiveVersion,
    });
  });

  it('そもそも版が無くても落とす', async () => {
    await expect(requireActivePrompt('article.body')).rejects.toMatchObject({
      code: PROMPT_ERROR_CODES.noActiveVersion,
    });
  });

  it('本文をそのまま返す', async () => {
    await createPromptVersionForAdmin({
      key: 'article.body',
      version: 'v1',
      body: 'あなたは編集者です。\n  丁寧に書いてください。',
      activate: true,
    });

    expect((await requireActivePrompt('article.body')).body).toBe(
      'あなたは編集者です。\n  丁寧に書いてください。',
    );
  });
});

describe('全て無効にする', () => {
  it('有効な版を落とせる', async () => {
    await create('v1', { activate: true });

    expect(await deactivatePromptForAdmin('article.body')).toBe(1);
    expect(await activeVersion()).toBeNull();
  });

  it('有効な版が無ければ0件', async () => {
    await create('v1');

    expect(await deactivatePromptForAdmin('article.body')).toBe(0);
  });
});
