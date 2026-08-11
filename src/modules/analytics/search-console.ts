/**
 * ブログと Search Console のプロパティの対応（TASKS G-1、SPEC 11.3）。
 *
 * 完了条件は「**ブログ単位で連携でき、トークンが暗号化される**」。
 *
 * ## トークンがブログごとに無い
 *
 * OPEN_QUESTIONS Q-030 で**サービスアカウント**を採ったため、
 * ブログごとの資格情報は存在しない。暗号化されるのは
 * **サービスアカウントの秘密鍵**で、`app_settings` に1つだけ入る（H-7）。
 *
 * ブログごとに決まるのは**どのプロパティを見るか**である。
 * `search_console_connections` はその対応と、直近の確認の結果を持つ。
 *
 * ## 連携を「保存できた」で終わりにしない
 *
 * モニターが Search Console 側でアドレスを追加していなければ、
 * URLを保存しただけでは何も取れない。**保存と同時に実際に問い合わせて、
 * 読めたかどうかを `connection_status` に残す。**
 * 取れないまま「連携済み」と見えると、G-2 が動き出すまで誰も気づけない。
 */

import { prisma } from '@/lib/db';
import {
  GoogleNotConfiguredError,
  createSearchConsoleClient,
  fetchAccessToken,
  parseServiceAccountKey,
  type PermissionLevel,
  type SearchConsoleClient,
} from '@/lib/google';
import { requireBlogForUser } from '@/modules/blogs';
import { getRuntimeEnv } from '@/modules/settings';
import {
  invalidPropertyUrlError,
  searchConsoleNotConnectedError,
} from './errors';

/** Search Console のプロパティのURLの形 */
export type PropertyKind =
  /** `sc-domain:example.com`。サブドメインとプロトコルをまとめて見る */
  | 'DOMAIN'
  /** `https://example.com/`。前方一致 */
  | 'URL_PREFIX';

export interface AppSearchConsoleConnection {
  blogId: string;
  propertyUrl: string;
  connectionStatus: string;
  lastSyncedAt: Date | null;
  lastErrorCode: string | null;
}

/**
 * プロパティのURLを整える。
 *
 * **2つの形を両方受ける。** Search Console のプロパティは
 * ドメインプロパティ（`sc-domain:example.com`）とURLプレフィックス
 * （`https://example.com/`）があり、**モニターがどちらを作ったかは
 * こちらで決められない。**片方しか受けないと、オンボーディングで
 * 「合っているのに弾かれる」が起きる。
 *
 * URLプレフィックスは**末尾の `/` まで含めて一致**しないと Search Console が
 * 見つけられないため、無ければ足す。
 *
 * @returns 整えた値。形が違えば `null`
 */
export function normalizePropertyUrl(
  raw: string,
): { propertyUrl: string; kind: PropertyKind } | null {
  const value = raw.trim();

  if (value === '') {
    return null;
  }

  if (value.startsWith('sc-domain:')) {
    const host = value.slice('sc-domain:'.length).trim().toLowerCase();

    // **ホスト名として最低限の形だけ見る。** 存在するかは問い合わせで分かる
    if (host === '' || host.includes('/') || !host.includes('.')) {
      return null;
    }

    return { propertyUrl: `sc-domain:${host}`, kind: 'DOMAIN' };
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  // **問い合わせ文字列とフラグメントは落とす。** プロパティの識別に使われない
  const path = parsed.pathname.endsWith('/')
    ? parsed.pathname
    : `${parsed.pathname}/`;

  return {
    propertyUrl: `${parsed.protocol}//${parsed.host}${path}`,
    kind: 'URL_PREFIX',
  };
}

/** 確認の結果。`connection_status` と、モニターへ出す案内のもとになる */
export type SearchConsoleCheck =
  | { status: 'CONNECTED'; permissionLevel: PermissionLevel }
  | { status: 'FAILED'; code: SearchConsoleFailureCode }
  | { status: 'UNTESTED'; code: 'UNAVAILABLE' };

export type SearchConsoleFailureCode =
  /** プロパティが見つからない／こちらが利用者に入っていない */
  | 'NOT_SHARED'
  /** 追加はされたが所有確認が済んでいない */
  | 'UNVERIFIED';

export interface SearchConsoleDeps {
  /** 差し替え用。既定は実HTTP */
  client?: SearchConsoleClient | undefined;
}

/**
 * 設定からクライアントを作る。
 *
 * @throws {GoogleNotConfiguredError} 鍵が未設定
 */
export async function createConfiguredSearchConsoleClient(): Promise<SearchConsoleClient> {
  const env = await getRuntimeEnv();
  const raw = env['GOOGLE_SERVICE_ACCOUNT_KEY']?.trim() ?? '';

  if (raw === '') {
    throw new GoogleNotConfiguredError(['GOOGLE_SERVICE_ACCOUNT_KEY']);
  }

  const account = parseServiceAccountKey(raw);
  const token = await fetchAccessToken(account);

  return createSearchConsoleClient(token);
}

/**
 * モニターに伝えるアドレス。
 *
 * **秘密ではない。** Search Console の「ユーザーと権限」へ追加してもらう
 * ためのもので、渡らなければ連携が始まらない。
 * **鍵から取り出すのはこの1項目だけ**で、`private_key` は返さない（SPEC 14.2）。
 *
 * @throws {GoogleNotConfiguredError} 鍵が未設定
 */
export async function readServiceAccountEmail(): Promise<string> {
  const env = await getRuntimeEnv();
  const raw = env['GOOGLE_SERVICE_ACCOUNT_KEY']?.trim() ?? '';

  if (raw === '') {
    throw new GoogleNotConfiguredError(['GOOGLE_SERVICE_ACCOUNT_KEY']);
  }

  return parseServiceAccountKey(raw).clientEmail;
}

async function check(
  client: SearchConsoleClient,
  propertyUrl: string,
): Promise<SearchConsoleCheck> {
  const outcome = await client.getSite(propertyUrl);

  switch (outcome.status) {
    case 'OK':
      return { status: 'CONNECTED', permissionLevel: outcome.permissionLevel };
    case 'NOT_FOUND':
      return { status: 'FAILED', code: 'NOT_SHARED' };
    case 'UNVERIFIED':
      return { status: 'FAILED', code: 'UNVERIFIED' };
    case 'UNAVAILABLE':
      // **Google側の一時的な失敗を `FAILED` にしない**（H-3 と同じ筋）。
      // 設定は正しいかもしれず、「つながっていません」と出すと直せない指摘になる
      return { status: 'UNTESTED', code: 'UNAVAILABLE' };
  }
}

function toApp(row: {
  blogId: string;
  propertyUrl: string;
  connectionStatus: string;
  lastSyncedAt: Date | null;
  lastErrorCode: string | null;
}): AppSearchConsoleConnection {
  return {
    blogId: row.blogId,
    propertyUrl: row.propertyUrl,
    connectionStatus: row.connectionStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastErrorCode: row.lastErrorCode,
  };
}

export interface ConnectSearchConsoleResult {
  connection: AppSearchConsoleConnection;
  check: SearchConsoleCheck;
}

/**
 * ブログにプロパティを結びつける（完了条件「ブログ単位で連携でき」）。
 *
 * **保存と同時に確かめる。** 読めないまま「連携済み」に見えると、
 * G-2 が動き出すまで誰も気づけない。
 *
 * **確かめられなくても保存はする。** モニターが先にURLを入れ、
 * あとから Search Console 側で権限を渡す順序がありうる。
 * その場合は `connection_status` が `FAILED` のまま残り、やり直せる。
 */
export async function connectSearchConsoleForUser(
  params: { userId: string; blogId: string; propertyUrl: string },
  deps: SearchConsoleDeps = {},
): Promise<ConnectSearchConsoleResult> {
  const blog = await requireBlogForUser(params);
  const normalized = normalizePropertyUrl(params.propertyUrl);

  if (normalized === null) {
    throw invalidPropertyUrlError();
  }

  const client = deps.client ?? (await createConfiguredSearchConsoleClient());
  const result = await check(client, normalized.propertyUrl);

  const data = {
    propertyUrl: normalized.propertyUrl,
    connectionStatus:
      result.status === 'CONNECTED' ? 'CONNECTED' : result.status,
    // **直したら消える。** 前回の理由が残っていると、直った後も出続ける
    lastErrorCode: result.status === 'CONNECTED' ? null : result.code,
  } as const;

  const row = await prisma.searchConsoleConnection.upsert({
    where: { blogId: blog.id },
    create: { blogId: blog.id, ...data },
    update: data,
    select: {
      blogId: true,
      propertyUrl: true,
      connectionStatus: true,
      lastSyncedAt: true,
      lastErrorCode: true,
    },
  });

  return { connection: toApp(row), check: result };
}

/** 結びつきを見る。**無ければ `null`**（未連携は異常ではない） */
export async function findSearchConsoleConnectionForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppSearchConsoleConnection | null> {
  const blog = await requireBlogForUser(params);

  const row = await prisma.searchConsoleConnection.findUnique({
    where: { blogId: blog.id },
    select: {
      blogId: true,
      propertyUrl: true,
      connectionStatus: true,
      lastSyncedAt: true,
      lastErrorCode: true,
    },
  });

  return row === null ? null : toApp(row);
}

/**
 * いま読めるかを確かめ直す。
 *
 * **プロパティのURLは変えない。** 変えたいなら
 * `connectSearchConsoleForUser` を呼ぶ。ここは状態だけを更新する。
 */
export async function testSearchConsoleForUser(
  params: { userId: string; blogId: string },
  deps: SearchConsoleDeps = {},
): Promise<ConnectSearchConsoleResult> {
  const existing = await findSearchConsoleConnectionForUser(params);

  if (existing === null) {
    throw searchConsoleNotConnectedError();
  }

  const client = deps.client ?? (await createConfiguredSearchConsoleClient());
  const result = await check(client, existing.propertyUrl);

  const row = await prisma.searchConsoleConnection.update({
    where: { blogId: params.blogId },
    data: {
      connectionStatus:
        result.status === 'CONNECTED' ? 'CONNECTED' : result.status,
      lastErrorCode: result.status === 'CONNECTED' ? null : result.code,
    },
    select: {
      blogId: true,
      propertyUrl: true,
      connectionStatus: true,
      lastSyncedAt: true,
      lastErrorCode: true,
    },
  });

  return { connection: toApp(row), check: result };
}

/**
 * 結びつきを外す。
 *
 * **行ごと消す。** WordPress（`REVOKED` で `site_url` を残す・Q-007）と違い、
 * **同じブログで別のプロパティに繋ぎ直すのは誤りではない。**
 * ドメインプロパティとURLプレフィックスの取り違えは起きるし、
 * 残しておくべき秘密も無い。
 */
export async function disconnectSearchConsoleForUser(params: {
  userId: string;
  blogId: string;
}): Promise<void> {
  const blog = await requireBlogForUser(params);

  await prisma.searchConsoleConnection.deleteMany({
    where: { blogId: blog.id },
  });
}
