import { describe, expect, it } from 'vitest';
import {
  buildApprovalUrl,
  buildProposalMessages,
  truncate,
} from '@/modules/line';

/**
 * 提案の通知文（TASKS F-2、SPEC 8.2）。
 *
 * **文面をAIに書かせない。** 毎回同じ形で届くこと自体が意味を持つ —
 * 「確認時間：約3分」という前提は、読む場所が決まっていることに
 * 支えられている。
 */

const notification = {
  approvalId: 'approval-1',
  blogName: '格安SIMブログ',
  articleTitle: '格安SIMの選び方',
  proposalReason: '集客記事です。読者を収益記事へ誘導します。',
  liffBaseUrl: 'https://liff.line.me/1234567890-abcdefgh',
};

describe('文字数で切る', () => {
  it('収まっていればそのまま', () => {
    expect(truncate('あいうえお', 10)).toBe('あいうえお');
  });

  it('超えたら省略記号を付ける', () => {
    expect(truncate('あいうえお', 3)).toBe('あい…');
  });

  /** **`String.length` で数えない**（E-11 と同じ理由） */
  it('サロゲートペアを1文字と数える', () => {
    expect(truncate('𠮷𠮷𠮷', 3)).toBe('𠮷𠮷𠮷');
  });

  it('前後の空白は落とす', () => {
    expect(truncate('  あい  ', 10)).toBe('あい');
  });
});

describe('承認詳細のURL', () => {
  it('承認IDを末尾に付ける', () => {
    expect(
      buildApprovalUrl({
        liffBaseUrl: 'https://liff.line.me/x',
        approvalId: 'a-1',
      }),
    ).toBe('https://liff.line.me/x/approvals/a-1');
  });

  it('末尾のスラッシュを重ねない', () => {
    expect(
      buildApprovalUrl({
        liffBaseUrl: 'https://liff.line.me/x/',
        approvalId: 'a-1',
      }),
    ).toBe('https://liff.line.me/x/approvals/a-1');
  });
});

describe('通知の組み立て（SPEC 8.2）', () => {
  it('ボタンは「内容を確認」と「今回は見送る」', () => {
    const [message] = buildProposalMessages(notification);

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    expect(message.template.actions.map((action) => action.label)).toEqual([
      '内容を確認',
      '今回は見送る',
    ]);
  });

  it('確認ボタンは承認詳細へ飛ぶ', () => {
    const [message] = buildProposalMessages(notification);

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    const [confirm] = message.template.actions;

    expect(confirm).toEqual({
      type: 'uri',
      label: '内容を確認',
      uri: 'https://liff.line.me/1234567890-abcdefgh/approvals/approval-1',
    });
  });

  /** 見送りは LIFF を開かずに済ませたい操作。受け口は F-6 */
  it('見送りは postback で承認IDを持つ', () => {
    const [message] = buildProposalMessages(notification);

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    const skip = message.template.actions[1];

    expect(skip?.type).toBe('postback');
    expect(skip).toMatchObject({ data: expect.stringContaining('approval-1') });
  });

  it('ブログ名を見出しに出す', () => {
    const [message] = buildProposalMessages(notification);

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    expect(message.template.title).toContain('格安SIMブログ');
  });

  /** **通知一覧に出る文。** 開かなくても何の話か分かるようにする */
  it('altText に記事タイトルを入れる', () => {
    const [message] = buildProposalMessages(notification);

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    expect(message.altText).toContain('格安SIMの選び方');
  });

  it('提案理由を本文に出す', () => {
    const [message] = buildProposalMessages(notification);

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    expect(message.template.text).toContain('誘導');
  });

  /** LINE の制限を超えると送信が落ちる */
  it('長いブログ名でも見出しの制限に収まる', () => {
    const [message] = buildProposalMessages({
      ...notification,
      blogName: 'あ'.repeat(200),
    });

    if (message?.type !== 'template') {
      throw new Error('template ではない');
    }

    expect([...message.template.title].length).toBeLessThanOrEqual(40);
    expect([...message.template.text].length).toBeLessThanOrEqual(60);
  });
});
