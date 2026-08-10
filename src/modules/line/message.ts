/**
 * 提案の通知文（TASKS F-2、SPEC 8.2）。
 *
 * ## 文面をAIに書かせない
 *
 * SPEC 8.2 が形式を定めている。**毎回同じ形で届くこと**自体が意味を持つ —
 * 3分で確認できるという前提（「確認時間：約3分」）は、読む場所が
 * 決まっていることに支えられている。
 *
 * 提案理由は F-1 がコードで組み立てたものをそのまま載せる。
 *
 * DBも外部も触らない純粋な処理。
 */

import type { LineMessage } from '@/lib/line';

/** LINE のテンプレートメッセージの制限 */
const TITLE_MAX = 40;
const TEXT_MAX = 60;
const ALT_TEXT_MAX = 400;

export interface ProposalNotification {
  approvalId: string;
  blogName: string;
  articleTitle: string;
  proposalReason: string;
  /** LIFF の承認詳細画面 */
  liffBaseUrl: string;
}

/**
 * 文字数で切る。
 *
 * **`String.length` ではなくコードポイントで数える**（E-11 と同じ理由）。
 * LINE の制限も文字数で、サロゲートペアを2文字と数えると短く切りすぎる。
 */
export function truncate(text: string, max: number): string {
  const chars = [...text.trim()];

  if (chars.length <= max) {
    return chars.join('');
  }

  return `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * 承認詳細画面のURLを組み立てる。
 *
 * **`approvalId` を末尾に付けるだけ。** 呼び出し側にURLを作らせない —
 * 作らせると、通知の飛び先を他人の承認に向けられる。
 */
export function buildApprovalUrl(params: {
  liffBaseUrl: string;
  approvalId: string;
}): string {
  const base = params.liffBaseUrl.replace(/\/+$/, '');

  return `${base}/approvals/${params.approvalId}`;
}

/**
 * 提案の通知を組み立てる（SPEC 8.2）。
 *
 * ボタンは「内容を確認」「今回は見送る」の2つ。
 * **見送りは `postback`** — 押した時点で LIFF を開かずに済ませたい操作で、
 * 受け口は F-6。
 */
export function buildProposalMessages(
  notification: ProposalNotification,
): LineMessage[] {
  const title = truncate(`【${notification.blogName}】`, TITLE_MAX);
  const body = truncate(
    `${notification.articleTitle}\n${notification.proposalReason}`,
    TEXT_MAX,
  );

  return [
    {
      type: 'template',
      // **通知一覧に出る文。** 開かなくても何の話か分かるようにする
      altText: truncate(
        `【${notification.blogName}】本日の提案：${notification.articleTitle}`,
        ALT_TEXT_MAX,
      ),
      template: {
        type: 'buttons',
        title,
        text: body,
        actions: [
          {
            type: 'uri',
            label: '内容を確認',
            uri: buildApprovalUrl({
              liffBaseUrl: notification.liffBaseUrl,
              approvalId: notification.approvalId,
            }),
          },
          {
            type: 'postback',
            label: '今回は見送る',
            data: `action=skip&approvalId=${notification.approvalId}`,
            displayText: '今回は見送ります',
          },
        ],
      },
    },
  ];
}
