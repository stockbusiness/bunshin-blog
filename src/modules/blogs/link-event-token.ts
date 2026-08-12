import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ownedBy, requireFound } from './ownership';

/**
 * クリック受信API（D-12）のトークン（TASKS D-12、OPEN_QUESTIONS Q-001 の再決定）。
 *
 * リダイレクタを各ブログのドメインへ移したことで、クリックは
 * **WordPress → Bunshin の受信API**という送信になった。その送信元が
 * 「どのブログか」を名乗る手段がこれ。
 *
 * ## 保存するのはハッシュだけ
 *
 * Bunshin は照合しかしないので、原文を持つ理由が無い。**DBを読めた相手が
 * 他ブログのイベントを投入できるようにしない**（`admin_login_tokens` と同じ）。
 *
 * 原文は発行した瞬間にしか出せない。**画面に「もう一度見る」を作らない。**
 *
 * ## トークンがブログを決める
 *
 * `blogs.link_event_token_hash` は `UNIQUE`。受信APIは**この1列でブログを引く。**
 * ブログIDを本文で受けてからトークンを照合する形にすると、**照合を1か所
 * 忘れただけで他ブログのイベントを名乗れる。**
 */

/** トークンの長さ（バイト）。base64url で43文字になる */
const TOKEN_BYTES = 32;

/** 推測できないトークンを作る */
export function generateLinkEventToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 保存・照合用のハッシュ。
 *
 * **ソルトを付けない。** トークン自体が32バイトの乱数で、総当たりも
 * 辞書攻撃も成立しない。ソルトを付けるとハッシュから引けなくなる
 * （`hashLoginToken` と同じ）。
 */
export function hashLinkEventToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * トークンを発行する（作り直す）。
 *
 * **既に発行済みでも作り直す。** 漏れたときに差し替える手段が要る。
 * 古いトークンはその瞬間に効かなくなる（列が1つしか無い）。
 *
 * @returns 原文。**呼び出し側は一度だけ画面へ出し、保存しない**
 */
export async function issueLinkEventTokenForUser(params: {
  userId: string;
  blogId: string;
  now?: Date;
}): Promise<{ token: string; issuedAt: Date }> {
  const token = generateLinkEventToken();
  const issuedAt = params.now ?? new Date();

  const result = await prisma.blog.updateMany({
    where: ownedBy({ userId: params.userId, id: params.blogId }),
    data: {
      linkEventTokenHash: hashLinkEventToken(token),
      linkEventTokenIssuedAt: issuedAt,
    },
  });

  // 0件なら「存在しない」か「他人のもの」。どちらも404に揃える
  requireFound(result.count === 0 ? null : result.count);

  return { token, issuedAt };
}

/**
 * トークンからブログを引く（受信APIが使う）。
 *
 * **`userId` を取らない。** 叩くのは各ブログのWordPressで、セッションが無い。
 * **トークンがブログを決める**ので、これ以上の絞り込みが要らない
 * （`findRedirectTargetByCode` と同じ性格の入口）。
 *
 * **見つからない理由を分けない。** 「トークンが無い」と「効かなくなった」を
 * 区別すると、総当たりで有効なトークンの有無を調べられる。
 */
export async function findBlogIdByLinkEventToken(
  token: string,
): Promise<string | null> {
  // DBを引く前に形で弾く（総当たりの負荷を落とす）
  if (token === '' || token.length > 256) {
    return null;
  }

  const row = await prisma.blog.findUnique({
    where: { linkEventTokenHash: hashLinkEventToken(token) },
    select: { id: true, status: true },
  });

  // **閉じたブログのイベントは受けない。** 閉じたあとに届くものは、
  // スニペットの外し忘れか、トークンの持ち出し
  if (row === null || row.status === 'CLOSED') {
    return null;
  }

  return row.id;
}
