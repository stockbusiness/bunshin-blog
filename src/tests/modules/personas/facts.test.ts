import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  FACT_CONTENT_MAX_LENGTH,
  FACT_SOURCES,
  FACT_VERIFICATIONS,
  PERSONA_ERROR_CODES,
  canUseFirstPerson,
  isFirstPersonBlocked,
  normalizeCreatePersonaFact,
  normalizeUpdatePersonaFact,
  type CreatePersonaFactInput,
  type FactSource,
  type FactVerification,
} from '@/modules/personas';

/**
 * 本人の事実の規則（TASKS D-6、SPEC 5.7・9.6）。
 *
 * 完了条件は「**`AI_INFERENCE` かつ `UNVERIFIED` が一人称利用不可の
 * フラグを持つ**」。
 *
 * AIが推測しただけの体験を「私は使いました」と書くと、それは**架空の
 * 口コミ**になる（SPEC 9.6 の禁止事項）。**組み合わせを網羅して確かめる。**
 */

function input(
  overrides: Partial<CreatePersonaFactInput> = {},
): CreatePersonaFactInput {
  return {
    personaId: '00000000-0000-4000-8000-0000000000a1',
    factType: 'EXPERIENCE',
    content: '半年ほど使いました',
    source: 'USER_INPUT',
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('canUseFirstPerson（完了条件）', () => {
  /** **これが SPEC 5.7 そのもの。** 要望が `true` でも落とす */
  it('AI_INFERENCE かつ UNVERIFIED は必ず false', () => {
    expect(
      canUseFirstPerson({
        source: 'AI_INFERENCE',
        verification: 'UNVERIFIED',
        requested: true,
      }),
    ).toBe(false);
  });

  /**
   * **裏取りで否定された事実を一人称で書くのは、未確認より悪い。**
   * SPEC 5.7 は明記していないが、`REJECTED` を許す読み方は成り立たない。
   */
  it.each(FACT_SOURCES)('%s でも REJECTED なら false', (source) => {
    expect(
      canUseFirstPerson({
        source,
        verification: 'REJECTED',
        requested: true,
      }),
    ).toBe(false);
  });

  it('AI_INFERENCE でも VERIFIED なら使える', () => {
    expect(
      canUseFirstPerson({
        source: 'AI_INFERENCE',
        verification: 'VERIFIED',
        requested: true,
      }),
    ).toBe(true);
  });

  it.each(['USER_INPUT', 'ADMIN_INTERVIEW', 'EXISTING_CONTENT'] as const)(
    '%s は UNVERIFIED でも使える',
    (source) => {
      expect(
        canUseFirstPerson({
          source,
          verification: 'UNVERIFIED',
          requested: true,
        }),
      ).toBe(true);
    },
  );

  it('要望していなければ常に false', () => {
    expect(
      canUseFirstPerson({
        source: 'USER_INPUT',
        verification: 'VERIFIED',
        requested: false,
      }),
    ).toBe(false);
  });

  /** 組み合わせを網羅する。禁じられるのは REJECTED と AI×UNVERIFIED だけ */
  it.each(
    FACT_SOURCES.flatMap((source) =>
      FACT_VERIFICATIONS.map(
        (verification) =>
          [source, verification] as [FactSource, FactVerification],
      ),
    ),
  )('%s × %s', (source, verification) => {
    const blocked =
      verification === 'REJECTED' ||
      (source === 'AI_INFERENCE' && verification === 'UNVERIFIED');

    expect(canUseFirstPerson({ source, verification, requested: true })).toBe(
      !blocked,
    );
    expect(isFirstPersonBlocked({ source, verification })).toBe(blocked);
  });
});

describe('normalizeCreatePersonaFact', () => {
  it('既定は UNVERIFIED・一人称不可', () => {
    expect(normalizeCreatePersonaFact(input())).toMatchObject({
      verification: 'UNVERIFIED',
      usableFirstPerson: false,
    });
  });

  /** **呼び出し側の指定をそのまま保存しない** */
  it('禁じられる組み合わせでは要望を落とす', () => {
    expect(
      normalizeCreatePersonaFact(
        input({
          source: 'AI_INFERENCE',
          verification: 'UNVERIFIED',
          usableFirstPerson: true,
        }),
      ).usableFirstPerson,
    ).toBe(false);
  });

  it('許される組み合わせでは要望を通す', () => {
    expect(
      normalizeCreatePersonaFact(
        input({
          source: 'USER_INPUT',
          verification: 'VERIFIED',
          usableFirstPerson: true,
        }),
      ).usableFirstPerson,
    ).toBe(true);
  });

  it('前後の空白を落とす', () => {
    expect(
      normalizeCreatePersonaFact(input({ content: '  使った  ' })).content,
    ).toBe('使った');
  });

  it.each([
    ['種類', { factType: 'NOPE' as CreatePersonaFactInput['factType'] }],
    ['出どころ', { source: 'NOPE' as CreatePersonaFactInput['source'] }],
    [
      '裏取り',
      { verification: 'NOPE' as CreatePersonaFactInput['verification'] },
    ],
  ])('知らない %s を拒否する', (_label, overrides) => {
    expect(codeOf(() => normalizeCreatePersonaFact(input(overrides)))).toBe(
      PERSONA_ERROR_CODES.invalidPersona,
    );
  });

  it.each([['   '], ['あ'.repeat(FACT_CONTENT_MAX_LENGTH + 1)]])(
    '内容 %o を拒否する',
    (content) => {
      expect(codeOf(() => normalizeCreatePersonaFact(input({ content })))).toBe(
        PERSONA_ERROR_CODES.invalidPersona,
      );
    },
  );
});

describe('normalizeUpdatePersonaFact', () => {
  const usable = {
    source: 'AI_INFERENCE' as const,
    verification: 'VERIFIED' as const,
    usableFirstPerson: true,
  };

  it('渡された項目だけを返す', () => {
    expect(normalizeUpdatePersonaFact({ content: '書き直し' }, usable)).toEqual(
      { content: '書き直し' },
    );
  });

  /**
   * **片方だけ更新したときに、禁じられる組み合わせを見落とさない。**
   * `VERIFIED` → `UNVERIFIED` に戻すと、`AI_INFERENCE` なら一人称利用が落ちる。
   */
  it('裏取りを戻すと一人称利用も落ちる', () => {
    expect(
      normalizeUpdatePersonaFact({ verification: 'UNVERIFIED' }, usable),
    ).toEqual({ verification: 'UNVERIFIED', usableFirstPerson: false });
  });

  it('出どころを変えても落ちる', () => {
    expect(
      normalizeUpdatePersonaFact(
        { source: 'AI_INFERENCE' },
        {
          source: 'USER_INPUT',
          verification: 'UNVERIFIED',
          usableFirstPerson: true,
        },
      ),
    ).toEqual({ source: 'AI_INFERENCE', usableFirstPerson: false });
  });

  it('REJECTED にすると落ちる', () => {
    expect(
      normalizeUpdatePersonaFact({ verification: 'REJECTED' }, usable),
    ).toEqual({ verification: 'REJECTED', usableFirstPerson: false });
  });

  // 落ちたあと、条件が戻れば再び使える
  it('裏取りが通れば再び使える', () => {
    expect(
      normalizeUpdatePersonaFact(
        { verification: 'VERIFIED', usableFirstPerson: true },
        {
          source: 'AI_INFERENCE',
          verification: 'UNVERIFIED',
          usableFirstPerson: false,
        },
      ),
    ).toEqual({ verification: 'VERIFIED', usableFirstPerson: true });
  });

  it('禁じられる組み合わせで true を要望しても落とす', () => {
    expect(
      normalizeUpdatePersonaFact(
        { usableFirstPerson: true },
        {
          source: 'AI_INFERENCE',
          verification: 'UNVERIFIED',
          usableFirstPerson: false,
        },
      ),
    ).toEqual({ usableFirstPerson: false });
  });

  it('何も変わらなければ空を返す', () => {
    expect(normalizeUpdatePersonaFact({}, usable)).toEqual({});
  });
});
