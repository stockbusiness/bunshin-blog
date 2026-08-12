import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { nodeHttpTransport, safeFetch } from '@/lib/http';
import { createBlogForUser } from '@/modules/blogs';
import {
  LP_ERROR_CODES,
  createOfferForUser,
  evaluateLandingPageForUser,
  type CreateOfferInput,
} from '@/modules/affiliate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * LPの自動評価を**実PostgreSQLと実HTTPサーバーで**確かめる（TASKS D-2）。
 *
 * 完了条件は「**SSRF対策を満たし、フォーム項目数・ページ長・viewportを
 * 判定**」。
 *
 * **偽の `safeFetch` では SSRF対策を確かめられない。** 差し替えたものは
 * 書いたとおりに動くだけで、「本当に内部アドレスへ行かないか」は
 * 実際に立てたサーバーへ向けないと分からない（A-9 の考え方と同じ）。
 */

const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body>
    <form>
      <input type="hidden" name="_token" value="xxxx">
      <input type="text" name="name">
      <input type="email" name="email">
      <select name="pref"><option>東京</option></select>
      <input type="submit" value="送信">
    </form>
  </body>
</html>`;

let prisma: PrismaClient;
let server: Server;
let port: number;
let owner: { id: string };
let blogId: string;

/** 応答を差し替えるための状態 */
let respond: (path: string) => {
  status: number;
  contentType: string;
  body: string;
};

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const result = respond(request.url ?? '/');

    response.writeHead(result.status, { 'content-type': result.contentType });
    response.end(result.body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve();
    });
  });
}

function input(landingPageUrl: string): CreateOfferInput {
  return {
    name: 'サンプル案件',
    aspName: 'サンプルASP',
    landingPageUrl,
    affiliateUrl: 'https://asp.example/click?a=xxxx',
    conversionType: 'FREE_SIGNUP',
  };
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await startServer();
});

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(async () => {
  await resetDatabase(prisma);

  respond = () => ({ status: 200, contentType: 'text/html', body: HTML });

  owner = await createUser(prisma, { displayName: '所有者' });
  blogId = (
    await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
      name: 'ブログ',
      slug: 'mine',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
});

/**
 * **`safeFetch` は名前解決した結果のIPで弾く**（C-7）。
 *
 * ローカルのテストサーバーは `127.0.0.1` なので、素直に呼ぶと
 * `HTTP_BLOCKED_ADDRESS` になる。**それがまさに確かめたい挙動**なので、
 * 「弾かれること」の確認にはそのまま使う。
 *
 * 判定そのものを確かめる場合は、到達を許すアドレスとして解決させる。
 */
function allowLocalhost(): { fetchFn: typeof safeFetch } {
  const fetchFn: typeof safeFetch = async (url, options) =>
    safeFetch(url, {
      ...options,
      // 公開アドレスとして解決させ、接続だけローカルへ向ける。
      // **ドキュメント用の範囲（203.0.113.0/24 など）は C-7 が弾く**ので
      // 使えない
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (request) =>
        nodeHttpTransport({ ...request, address: '127.0.0.1' }),
    });

  return { fetchFn };
}

describe('判定（SPEC 9.2.3）', () => {
  let offerId: string;

  beforeEach(async () => {
    offerId = (
      await createOfferForUser(
        { userId: owner.id, blogId },
        input(`http://lp.example.com:${port}/offer`),
      )
    ).id;
  });

  it('3項目を判定して保存する', async () => {
    const { offer, evaluation } = await evaluateLandingPageForUser(
      { userId: owner.id, blogId, offerId },
      allowLocalhost(),
    );

    // hidden と submit を除いた3項目（text・email・select）
    expect(evaluation.formFields).toBe(3);
    expect(evaluation.inputElements).toBe(4);
    expect(evaluation.mobileReady).toBe(true);
    expect(evaluation.contentLength).toBe(Buffer.byteLength(HTML, 'utf8'));

    expect(offer.linkMode).toBe('DIRECT');

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: {
        lpFormFields: true,
        lpMobileReady: true,
        lpContentLength: true,
        lpEvaluatedAt: true,
      },
    });

    expect(row).toMatchObject({
      lpFormFields: 3,
      lpMobileReady: true,
      lpContentLength: Buffer.byteLength(HTML, 'utf8'),
    });
    expect(row.lpEvaluatedAt).not.toBeNull();
  });

  it('viewport が無ければスマートフォン非対応として保存する', async () => {
    respond = () => ({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html><head></head><body><p>本文</p></body></html>',
    });

    const { evaluation } = await evaluateLandingPageForUser(
      { userId: owner.id, blogId, offerId },
      allowLocalhost(),
    );

    expect(evaluation.mobileReady).toBe(false);

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: { lpMobileReady: true },
    });
    expect(row.lpMobileReady).toBe(false);
  });

  /**
   * **一時的な障害で案件が選定から落ちるのを防ぐ。**
   * 失敗時に `NULL` へ戻すと、足切り（SPEC 9.2.3）に引っかかる。
   */
  it('失敗しても前回の結果を消さない', async () => {
    await evaluateLandingPageForUser(
      { userId: owner.id, blogId, offerId },
      allowLocalhost(),
    );

    respond = () => ({
      status: 503,
      contentType: 'text/html',
      body: '<html>メンテナンス中</html>',
    });

    await expect(
      evaluateLandingPageForUser(
        { userId: owner.id, blogId, offerId },
        allowLocalhost(),
      ),
    ).rejects.toMatchObject({ code: LP_ERROR_CODES.lpUnavailable });

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: { lpFormFields: true, lpMobileReady: true },
    });

    expect(row.lpFormFields).toBe(3);
    expect(row.lpMobileReady).toBe(true);
  });

  it('HTMLでなければ専用のコードで返す', async () => {
    respond = () => ({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.4',
    });

    await expect(
      evaluateLandingPageForUser(
        { userId: owner.id, blogId, offerId },
        allowLocalhost(),
      ),
    ).rejects.toMatchObject({ code: LP_ERROR_CODES.lpNotHtml });
  });
});

describe('SSRF対策（SPEC 14.3）', () => {
  /**
   * **これが完了条件の中心。** 差し替えていない経路（既定の `safeFetch`）で
   * ローカルのサーバーへ向けると、名前解決した結果のIPで弾かれる。
   */
  it('loopback のLPへ到達しない', async () => {
    const offerId = (
      await createOfferForUser(
        { userId: owner.id, blogId },
        input(`http://127.0.0.1:${port}/offer`),
      )
    ).id;

    await expect(
      evaluateLandingPageForUser({ userId: owner.id, blogId, offerId }),
    ).rejects.toMatchObject({ code: LP_ERROR_CODES.lpUnreachable });
  });

  it.each([
    ['http://localhost/offer'],
    ['http://10.0.0.1/offer'],
    ['http://192.168.0.1/offer'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[::1]/offer'],
  ])('%s へ到達しない', async (landingPageUrl) => {
    const offerId = (
      await createOfferForUser(
        { userId: owner.id, blogId },
        input(landingPageUrl),
      )
    ).id;

    await expect(
      evaluateLandingPageForUser({ userId: owner.id, blogId, offerId }),
    ).rejects.toMatchObject({ code: LP_ERROR_CODES.lpUnreachable });
  });

  /**
   * **理由を明かさない。** 到達禁止アドレスと名前解決の失敗を区別すると、
   * 応答の違いで内部の構成を調べられる。
   */
  it('到達できない理由をメッセージに出さない', async () => {
    const offerId = (
      await createOfferForUser(
        { userId: owner.id, blogId },
        input('http://169.254.169.254/latest/meta-data/'),
      )
    ).id;

    const error: unknown = await evaluateLandingPageForUser({
      userId: owner.id,
      blogId,
      offerId,
    }).catch((caught: unknown) => caught);

    expect((error as { message: string }).message).not.toContain(
      '169.254.169.254',
    );
  });

  // 到達できなかった案件を「フォーム項目0個＝満点」にしない
  it('到達できなければ評価列を埋めない', async () => {
    const offerId = (
      await createOfferForUser(
        { userId: owner.id, blogId },
        input('http://10.0.0.1/offer'),
      )
    ).id;

    await expect(
      evaluateLandingPageForUser({ userId: owner.id, blogId, offerId }),
    ).rejects.toThrow();

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: {
        lpFormFields: true,
        lpMobileReady: true,
        lpContentLength: true,
        lpEvaluatedAt: true,
      },
    });

    expect(row).toEqual({
      lpFormFields: null,
      lpMobileReady: null,
      lpContentLength: null,
      lpEvaluatedAt: null,
    });
  });
});

describe('所有権（SPEC 14.1）', () => {
  it('他人の案件は評価できない', async () => {
    const other = await createUser(prisma, { displayName: '別ユーザー' });
    const otherBlog = (
      await createBlogForUser(other.id, {
        personaId: (await createPersona(prisma, other.id)).id,
        name: '他人のブログ',
        slug: 'theirs',
        targetReader: '読者',
        slotNumber: 1,
      })
    ).id;
    const offerId = (
      await createOfferForUser(
        { userId: other.id, blogId: otherBlog },
        input(`http://lp.example.com:${port}/offer`),
      )
    ).id;

    await expect(
      evaluateLandingPageForUser({ userId: owner.id, blogId, offerId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
