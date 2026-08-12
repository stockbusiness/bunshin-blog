import { describe, expect, it } from 'vitest';
import {
  SNIPPET_RULES_VERSION,
  assertSnippetEndpoint,
  buildLinkSnippet,
} from '@/modules/blogs';

/**
 * `bunshin-go.php` の組み立て（TASKS I-9、D-12）。
 *
 * ここで確かめるのは、**壊れたPHPを渡さないこと。**
 * 構文が壊れると**プラグインが丸ごと動かず、リンクが全部404になる。**
 */

const TOKEN = 'a'.repeat(32);
const ENDPOINT = 'https://bunshin.example/api/link-events';

function snippet(overrides: { token?: string; endpoint?: string } = {}) {
  return buildLinkSnippet({
    token: overrides.token ?? TOKEN,
    endpoint: overrides.endpoint ?? ENDPOINT,
  });
}

describe('値を埋めて渡す', () => {
  it('トークンと受信APIが入る', () => {
    const php = snippet();

    expect(php).toContain(`define('BUNSHIN_LINK_TOKEN', '${TOKEN}');`);
    expect(php).toContain(`define('BUNSHIN_EVENT_ENDPOINT', '${ENDPOINT}');`);
  });

  /** **貼る場所を残さない。** 残っていれば、それは埋め忘れである */
  it('貼り付けの案内が残っていない', () => {
    expect(snippet()).not.toContain('ここに');
  });

  /**
   * **`mu-plugins` には有効化の合図が無い。** 版が違うときだけ
   * 自分で1回流す（パーマリンクを保存し直す作業が要らない）
   */
  it('書き換え規則を自分で流す', () => {
    const php = snippet();

    expect(php).toContain(
      `define('BUNSHIN_RULES_VERSION', '${SNIPPET_RULES_VERSION}');`,
    );
    expect(php).toContain('flush_rewrite_rules(false);');
  });

  /** **IPアドレスを保存しない。UA はハッシュ化する**（D-8・D-12） */
  it('IPを送らず、UAはハッシュにする', () => {
    const php = snippet();

    expect(php).toContain("hash('sha256', $agent)");
    expect(php).not.toContain('REMOTE_ADDR');
  });
});

/**
 * **PHPの文字列リテラルへ入れる。** 引用符や改行が混ざると
 * 構文エラーになり、**リンクが全部404になる**
 */
describe('壊れたPHPを渡さない', () => {
  it.each([
    { name: '引用符', value: "https://evil.example/'+die()+'" },
    { name: '改行', value: 'https://evil.example/\na' },
    { name: '円記号', value: 'https://evil.example/\\' },
  ])('受信APIに$nameが混ざれば組み立てない', ({ value }) => {
    expect(() => snippet({ endpoint: value })).toThrow();
  });

  /** **トークンを `Authorization` に載せて送る**（平文で流さない） */
  it('http の受信APIは受け付けない', () => {
    expect(() =>
      snippet({ endpoint: 'http://bunshin.example/api/link-events' }),
    ).toThrow();
  });

  it.each([
    { name: '空', value: '' },
    { name: '短すぎる', value: 'abc' },
    { name: '使えない文字', value: `${'a'.repeat(30)}';` },
  ])('トークンが$nameなら組み立てない', ({ value }) => {
    expect(() => snippet({ token: value })).toThrow();
  });
});

/**
 * **発行する前に確かめられる。** 発行してから組み立てに失敗すると、
 * 古いトークンが無効になったのに新しいファイルが手に入らない
 */
describe('受信APIの検査だけを先に呼べる', () => {
  it('正しければ通る', () => {
    expect(() => assertSnippetEndpoint(ENDPOINT)).not.toThrow();
  });

  it('URLとして読めなければ落ちる', () => {
    expect(() => assertSnippetEndpoint('not a url')).toThrow();
  });
});
