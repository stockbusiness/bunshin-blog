import { describe, expect, it, vi } from 'vitest';
import { draftOfferFromLandingPage, htmlToText } from '@/modules/affiliate';
import type { AiProvider } from '@/lib/ai';

/**
 * 紹介先のページから案件の下書きを作る（Q-053、段8）。
 *
 * **AIは案を出す係**（CONTENT_PLANNING 1.1）。ここが返すのは下書きで、
 * **保存しない。** とくに `facts` を下書きのまま通すと
 * `facts_updated_at` が入り、**確かめていないのに「確かめた」ことになる**
 * （D-13・Q-022）。
 */

function html(body: string): string {
  return `<html><head><title>t</title></head><body>${body}</body></html>`;
}

function fetchReturning(body: string, status = 200) {
  return vi.fn(async () => ({
    status,
    headers: { 'content-type': 'text/html' },
    body,
    finalUrl: 'https://lp.example.com',
  })) as never;
}

function providerReturning(text: string): AiProvider {
  return {
    complete: vi.fn(async () => ({
      text,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
      provider: 'test',
      model: 'test',
    })),
  } as unknown as AiProvider;
}

describe('本文の取り出し', () => {
  /** **`script` は中身ごと落とす。** JS の文字列が「事実」として拾われる */
  it('script と style の中身を落とす', () => {
    const text = htmlToText(
      html('<script>var price = 9999;</script><p>月額1,480円</p>'),
    );

    expect(text).not.toContain('9999');
    expect(text).toContain('月額1,480円');
  });

  /** **タイトルは残す。** 商品名がそこにあることが多い */
  it('タグを落として空白を詰める', () => {
    expect(htmlToText(html('<p>あ</p>\n\n<p>い</p>'))).toBe('t あ い');
  });
});

describe('下書きを作る', () => {
  it('名前・成果条件・事実を返す', async () => {
    const draft = await draftOfferFromLandingPage('https://lp.example.com', {
      provider: providerReturning(
        JSON.stringify({
          name: '格安SIM A',
          conversionType: 'FREE_SIGNUP',
          facts: ['月額1,480円', '初期費用なし'],
        }),
      ),
      fetchFn: fetchReturning(html('<p>月額1,480円</p>')),
    });

    expect(draft).toEqual({
      name: '格安SIM A',
      conversionType: 'FREE_SIGNUP',
      facts: ['月額1,480円', '初期費用なし'],
    });
  });

  /** **同じ記述が2つあっても、人が確かめる手間が増えるだけ** */
  it('事実の重複を落とす', async () => {
    const draft = await draftOfferFromLandingPage('https://lp.example.com', {
      provider: providerReturning(
        JSON.stringify({
          name: 'A',
          conversionType: 'PURCHASE',
          facts: ['月額1,480円', '月額1,480円'],
        }),
      ),
      fetchFn: fetchReturning(html('<p>月額1,480円</p>')),
    });

    expect(draft.facts).toEqual(['月額1,480円']);
  });

  it('コードフェンス付きでも読む', async () => {
    const draft = await draftOfferFromLandingPage('https://lp.example.com', {
      provider: providerReturning(
        '```json\n{"name":"A","conversionType":"TRIAL","facts":[]}\n```',
      ),
      fetchFn: fetchReturning(html('<p>本文</p>')),
    });

    expect(draft.name).toBe('A');
  });
});

/**
 * **手で入力する道を塞がない。** 読み取れないときは、そう言って
 * 画面へ戻す（推測で埋めない）。
 */
describe('読み取れないとき', () => {
  it('ページが取れなければ、手入力を案内する', async () => {
    await expect(
      draftOfferFromLandingPage('https://lp.example.com', {
        provider: providerReturning('{}'),
        fetchFn: fetchReturning('', 500),
      }),
    ).rejects.toThrow(/手で入力/);
  });

  it('文字が無ければ、手入力を案内する', async () => {
    await expect(
      draftOfferFromLandingPage('https://lp.example.com', {
        provider: providerReturning('{}'),
        fetchFn: fetchReturning('<html><body>   </body></html>'),
      }),
    ).rejects.toThrow(/手で入力/);
  });

  /** **応答本文を例外へ載せない**（SPEC 14.2） */
  it('AIの応答が読めなければ、中身を漏らさない', async () => {
    await expect(
      draftOfferFromLandingPage('https://lp.example.com', {
        provider: providerReturning('秘密のような何か'),
        fetchFn: fetchReturning(html('<p>本文</p>')),
      }),
    ).rejects.toThrow(/読み取れませんでした/);
  });

  it('成果条件が知らない値なら受け取らない', async () => {
    await expect(
      draftOfferFromLandingPage('https://lp.example.com', {
        provider: providerReturning(
          JSON.stringify({ name: 'A', conversionType: 'UNKNOWN', facts: [] }),
        ),
        fetchFn: fetchReturning(html('<p>本文</p>')),
      }),
    ).rejects.toThrow(/読み取れませんでした/);
  });
});
