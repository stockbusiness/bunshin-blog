/**
 * Google API を叩くための型とエラー（TASKS G-1）。
 *
 * **サービスアカウントで認証する**（OPEN_QUESTIONS Q-030）。
 * OAuth の同意画面は使わない。
 */

import { Secret } from '@/lib/crypto';

/**
 * サービスアカウントの鍵。
 *
 * **`private_key` は `Secret` に包む。** ログや例外へそのまま流れると、
 * 全モニターの Search Console を読める鍵が出ていくことになる（SPEC 14.2）。
 *
 * `clientEmail` は**秘密ではない。** モニターに渡して Search Console の
 * 「ユーザーと権限」へ追加してもらうためのアドレスで、渡らなければ
 * 連携そのものが始まらない。
 */
export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: Secret;
}

/** アクセストークン。**有効期限を持つ**ので、使い回すときは期限を見る */
export interface GoogleAccessToken {
  token: Secret;
  /** 失効する時刻 */
  expiresAt: Date;
}

export class GoogleNotConfiguredError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    // **足りない名前だけを書く。値は書かない**（SPEC 14.2）
    super(`Google の設定が足りません: ${missing.join(', ')}`);
    this.name = 'GoogleNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * 鍵の形が読めない。
 *
 * **元の例外を持たない。** JSON の解析エラーには本文の一部が載りうる。
 */
export class GoogleServiceAccountInvalidError extends Error {
  constructor(reason: string) {
    super(`サービスアカウントの鍵を読めません: ${reason}`);
    this.name = 'GoogleServiceAccountInvalidError';
  }
}

/** Google への通信そのものが失敗した */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}
