/**
 * 同意画面に出す文言（TASKS H-6、SPEC 6.1 の段2・3）。
 *
 * **文言の正はここ。** `docs/CONSENT.md` は同じ文言を、運営者が読み返す
 * ための形で持つ。**2か所に別々の文を置かない**ため、
 * `src/tests/app/liff/consent-text.test.ts` が
 * **`docs/CONSENT.md` に同じ行があることを毎回確かめる。**
 *
 * 文言を直すときは、この配列と `docs/CONSENT.md` の両方を直す
 * （片方だけだとテストが落ちる）。
 */

export interface ConsentSection {
  kind: 'TERMS' | 'DATA_USE';
  title: string;
  body: string[];
}

export const CONSENT_SECTIONS: ConsentSection[] = [
  {
    kind: 'TERMS',
    title: '利用規約',
    body: [
      'この実験に参加するための約束です。',
      'ドメインとサーバーの費用はご自身の負担になります。',
      'ブログはご自身のドメインで動き、記事の公開はご自身の承認で行われます。',
      '承認していない記事が公開されることはありません。',
      'いつでもやめられます。やめても、それまでのブログと記事は残ります。',
    ],
  },
  {
    kind: 'DATA_USE',
    title: 'データの使い方',
    body: [
      '実験の結果をまとめるために、次の記録を使わせていただきます。',
      '・提案に答えた記録（承認・修正依頼・見送り）',
      '・公開した記事と、その表示回数やクリック数',
      '・登録した案件と成果の報告',
      'LINEのユーザーIDは、まとめや持ち出しには含めません。',
      '読者のIPアドレスは保存しません。',
    ],
  },
];
