import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONSENT_SECTIONS } from '@/app/liff/onboarding/_lib/consent-text';

/**
 * 同意の文言が2か所で食い違わないことを見張る（TASKS H-6）。
 *
 * **画面に出る文言の正は `consent-text.ts`。** `docs/CONSENT.md` は
 * 運営者が読み返すための形で同じ文言を持つ。
 *
 * 片方だけ直すとここが落ちる。**「直したつもり」で画面と文書がずれるのを
 * 防ぐ**（C-6 の自己維持ガードと同じ趣旨）。
 */

const DOC = readFileSync('docs/CONSENT.md', 'utf8');

describe('docs/CONSENT.md と同じ文言か', () => {
  it.each(
    CONSENT_SECTIONS.flatMap((section) =>
      section.body.map((line) => ({ kind: section.kind, line })),
    ),
  )('$kind: $line', ({ line }) => {
    expect(DOC).toContain(line);
  });

  it('見出しも載っている', () => {
    for (const section of CONSENT_SECTIONS) {
      expect(DOC).toContain(section.title);
    }
  });

  /** **2つに分ける**（参加の条件と記録の使い道は別の話） */
  it('同意は2つ', () => {
    expect(CONSENT_SECTIONS.map((section) => section.kind)).toEqual([
      'TERMS',
      'DATA_USE',
    ]);
  });
});
