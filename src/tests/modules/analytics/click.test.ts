import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashUserAgent, parseReferrerHost } from '@/modules/analytics';

/**
 * クリック記録に使う値の整形（TASKS D-8、SPEC 5.14・11.4）。
 *
 * **生のUAとURLを保存しない。** 残すのはホスト名とハッシュだけ。
 */

describe('parseReferrerHost', () => {
  it('ホスト名だけを取り出す', () => {
    expect(parseReferrerHost('https://blog.example.com/article?q=1#x')).toBe(
      'blog.example.com',
    );
  });

  // 記事のURLにはクエリが付く。利用者が入力した値が混ざりうる
  it('パスやクエリを残さない', () => {
    const host = parseReferrerHost('https://blog.example.com/a?token=secret');

    expect(host).not.toContain('token');
    expect(host).not.toContain('/a');
  });

  it('小文字に揃える', () => {
    expect(parseReferrerHost('https://Blog.Example.COM/a')).toBe(
      'blog.example.com',
    );
  });

  /**
   * `Referer` は付かないことがある（SPEC 11.4「referrerが欠落する場合が
   * あるため、完全値として扱わない」）。**欠落は異常ではない。**
   */
  it.each([[null], [undefined], [''], ['   ']])('%o なら null', (value) => {
    expect(parseReferrerHost(value)).toBeNull();
  });

  it.each([['これはURLではない'], ['javascript:alert(1)'], ['/relative/path']])(
    '%s なら null',
    (value) => {
      expect(parseReferrerHost(value)).toBeNull();
    },
  );

  it('異常に長いホストを弾く', () => {
    expect(
      parseReferrerHost(`https://${'a'.repeat(300)}.example.com/`),
    ).toBeNull();
  });
});

describe('hashUserAgent', () => {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';

  it('ハッシュにして返す', () => {
    expect(hashUserAgent(UA)).toBe(
      createHash('sha256').update(UA, 'utf8').digest('hex'),
    );
  });

  // 集計に要るのは「同じ端末からの連打か」であって、UAそのものではない
  it('生のUAを含まない', () => {
    expect(hashUserAgent(UA)).not.toContain('iPhone');
  });

  /**
   * **同じUAが同じハッシュになること自体が目的**（連打の判定に使う）。
   * 塩を入れると再起動のたびに別のハッシュになり、用をなさない。
   */
  it('同じUAは同じハッシュ', () => {
    expect(hashUserAgent(UA)).toBe(hashUserAgent(UA));
  });

  it('違うUAは違うハッシュ', () => {
    expect(hashUserAgent(UA)).not.toBe(hashUserAgent('curl/8.0'));
  });

  it.each([[null], [undefined], [''], ['  ']])('%o なら null', (value) => {
    expect(hashUserAgent(value)).toBeNull();
  });
});
