/**
 * 承認一覧の並べ分け（TASKS F-4、SPEC 6.1 `/liff/approvals`）。
 *
 * ```text
 * - 承認待ち
 * - 承認済み
 * - 修正依頼
 * - 見送り
 * ```
 *
 * ## `EXPIRED` の置き場所
 *
 * SPEC が挙げているのは上の4つで、`EXPIRED`（期限切れ）は入っていない。
 * **どこにも置かないと画面から消える**ため、「見送り」に含める。
 *
 * ただし**行の表示は「期限切れ」のまま分ける** — 「自分で見送った」と
 * 「期限が切れた」を同じに見せると、あとで振り返ったときに
 * 判断の記録として使えない。集計（G-7）は `status` をそのまま見るので、
 * ここでまとめても数字は混ざらない。
 *
 * ## `src/modules/approvals/` に置かない
 *
 * これは**画面の表示の話**で、`approvals` モジュールの `index.ts` は
 * `repository.ts` 経由で Prisma を引き込む。クライアントコンポーネントから
 * 読むと、ブラウザ向けの束に `node:dns` が混ざってビルドが落ちる
 * （MODULE_RULES 4「browser code must not import server-only」）。
 *
 * 表記が `_lib/labels.ts` にあるのと同じ理由。
 *
 * DBも外部も触らない純粋な処理。
 */

/** SPEC 6.1 の4つ */
export const APPROVAL_TABS = [
  'PENDING',
  'APPROVED',
  'REVISION_REQUESTED',
  'SKIPPED',
] as const;

export type ApprovalTab = (typeof APPROVAL_TABS)[number];

export const APPROVAL_TAB_LABELS: Readonly<Record<ApprovalTab, string>> = {
  PENDING: '承認待ち',
  APPROVED: '承認済み',
  REVISION_REQUESTED: '修正依頼',
  SKIPPED: '見送り',
};

/** 行に出す状態の名前。**タブより細かい** */
export const APPROVAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: '未読',
  VIEWED: '確認中',
  APPROVED: '承認済み',
  REVISION_REQUESTED: '修正依頼',
  SKIPPED: '見送り',
  EXPIRED: '期限切れ',
};

/**
 * 状態からタブを決める。
 *
 * `VIEWED`（開いたがまだ答えていない）は**承認待ち**。
 * 開いただけで一覧から消えると、「あとで答えよう」と閉じた提案を
 * 見つけられなくなる。
 */
export function approvalTabOf(status: string): ApprovalTab {
  switch (status) {
    case 'PENDING':
    case 'VIEWED':
      return 'PENDING';
    case 'APPROVED':
      return 'APPROVED';
    case 'REVISION_REQUESTED':
      return 'REVISION_REQUESTED';
    default:
      // `SKIPPED` と `EXPIRED`。知らない値もここへ落ちる —
      // **消えるより「見送り」に出るほうがまだ気づける**
      return 'SKIPPED';
  }
}

/** 行に出す状態の名前を返す。知らない値はそのまま返す */
export function approvalStatusLabel(status: string): string {
  return APPROVAL_STATUS_LABELS[status] ?? status;
}

/** まだ返事をしていないか（一覧の件数バッジに使う） */
export function isOpenApproval(status: string): boolean {
  return status === 'PENDING' || status === 'VIEWED';
}
