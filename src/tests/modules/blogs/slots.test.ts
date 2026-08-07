import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  BLOG_SLOT_ERROR_CODES,
  BLOG_SLOT_NUMBERS,
  MAX_BLOGS_PER_USER,
  availableSlots,
  isBlogSlotNumber,
  resolveSlotNumber,
  type AppBlog,
  type BlogSlotOccupancy,
} from '@/modules/blogs';

/**
 * スロット制御の判定（TASKS B-4）。
 *
 * 完了条件「4件目の登録が拒否される」「slot重複が拒否される」
 * 「`CLOSED` のスロットを再利用できない（Q-008）」を、DBを起こさずに固定する。
 * 実DBでの確認は `src/tests/integration/blogs-slots.test.ts`。
 */

function occupancy(
  slotNumber: number,
  status: AppBlog['status'] = 'ACTIVE',
): BlogSlotOccupancy {
  return {
    slotNumber: slotNumber as BlogSlotOccupancy['slotNumber'],
    blogId: `blog-${String(slotNumber)}`,
    status,
  };
}

/** `resolveSlotNumber` が投げた `AppError` を取り出す */
function catchError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (thrown) {
    return thrown as AppError;
  }

  throw new Error('例外が投げられませんでした');
}

describe('定数', () => {
  it('スロットは1〜3', () => {
    expect(BLOG_SLOT_NUMBERS).toEqual([1, 2, 3]);
  });

  it('上限はスロット数と一致する（SPEC 2.5 の最大3件）', () => {
    expect(MAX_BLOGS_PER_USER).toBe(3);
    expect(MAX_BLOGS_PER_USER).toBe(BLOG_SLOT_NUMBERS.length);
  });
});

describe('isBlogSlotNumber', () => {
  it('1〜3 を受け入れる', () => {
    expect(isBlogSlotNumber(1)).toBe(true);
    expect(isBlogSlotNumber(2)).toBe(true);
    expect(isBlogSlotNumber(3)).toBe(true);
  });

  it('範囲外・小数を拒否する', () => {
    expect(isBlogSlotNumber(0)).toBe(false);
    expect(isBlogSlotNumber(4)).toBe(false);
    expect(isBlogSlotNumber(-1)).toBe(false);
    expect(isBlogSlotNumber(1.5)).toBe(false);
    expect(isBlogSlotNumber(Number.NaN)).toBe(false);
  });
});

describe('availableSlots', () => {
  it('未使用なら全て空き', () => {
    expect(availableSlots([])).toEqual([1, 2, 3]);
  });

  it('使用中のスロットを除く', () => {
    expect(availableSlots([occupancy(2)])).toEqual([1, 3]);
  });

  it('CLOSED のスロットは空きに含めない（Q-008）', () => {
    expect(availableSlots([occupancy(1, 'CLOSED')])).toEqual([2, 3]);
  });

  it('3件使用済みなら空きは無い', () => {
    const used = [occupancy(1), occupancy(2, 'CLOSED'), occupancy(3, 'PAUSED')];

    expect(availableSlots(used)).toEqual([]);
  });
});

describe('resolveSlotNumber：スロット指定なし', () => {
  it('空いている最小の番号を割り当てる', () => {
    expect(resolveSlotNumber({ used: [] })).toBe(1);
    expect(resolveSlotNumber({ used: [occupancy(1)] })).toBe(2);
    expect(resolveSlotNumber({ used: [occupancy(1), occupancy(2)] })).toBe(3);
  });

  it('空いた番号があれば飛ばさずそこを使う', () => {
    expect(resolveSlotNumber({ used: [occupancy(2)] })).toBe(1);
  });

  it('CLOSED は空きとして扱わない（Q-008）', () => {
    // slot 1 を閉じても、次は 2 が割り当てられる
    expect(resolveSlotNumber({ used: [occupancy(1, 'CLOSED')] })).toBe(2);
  });

  it('3件使用済みなら 409 で拒否する', () => {
    const used = [occupancy(1), occupancy(2), occupancy(3)];
    const error = catchError(() => resolveSlotNumber({ used }));

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(409);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.limitReached);
    expect(error.message).toContain('最大3件');
    expect(error.details).toEqual({ limit: 3, used: [1, 2, 3] });
  });

  it('CLOSED を含めて3件なら4件目を拒否する（Q-008）', () => {
    const used = [occupancy(1, 'CLOSED'), occupancy(2), occupancy(3)];
    const error = catchError(() => resolveSlotNumber({ used }));

    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.limitReached);
  });
});

describe('resolveSlotNumber：スロット指定あり', () => {
  it('空いていればその番号を返す', () => {
    expect(resolveSlotNumber({ used: [occupancy(1)], requested: 3 })).toBe(3);
  });

  it('使用中なら 409 で拒否する', () => {
    const error = catchError(() =>
      resolveSlotNumber({ used: [occupancy(2)], requested: 2 }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.slotTaken);
    expect(error.details).toEqual({ slotNumber: 2, closed: false });
  });

  it('CLOSED のスロットは再利用できない（Q-008）', () => {
    const error = catchError(() =>
      resolveSlotNumber({ used: [occupancy(2, 'CLOSED')], requested: 2 }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.slotTaken);
    expect(error.message).toContain('再利用できません');
    expect(error.details).toEqual({ slotNumber: 2, closed: true });
  });

  it('CLOSED かどうかでメッセージを分ける', () => {
    const active = catchError(() =>
      resolveSlotNumber({ used: [occupancy(1)], requested: 1 }),
    );
    const closed = catchError(() =>
      resolveSlotNumber({ used: [occupancy(1, 'CLOSED')], requested: 1 }),
    );

    expect(active.message).not.toBe(closed.message);
  });

  it('ブログIDを漏らさない', () => {
    const error = catchError(() =>
      resolveSlotNumber({ used: [occupancy(3, 'CLOSED')], requested: 3 }),
    );

    expect(JSON.stringify(error.details)).not.toContain('blog-3');
  });

  it.each([0, 4, -1, 1.5])('範囲外の %s は 422 で拒否する', (requested) => {
    const error = catchError(() => resolveSlotNumber({ used: [], requested }));

    expect(error.status).toBe(422);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.outOfRange);
    expect(error.details).toEqual({ requested });
  });

  it('範囲外の判定を上限判定より先に行う', () => {
    // 3件埋まっていても、指定が不正なら「範囲外」を返す。
    // 入力の誤りを「上限に達した」と伝えると原因が分からなくなる
    const used = [occupancy(1), occupancy(2), occupancy(3)];
    const error = catchError(() => resolveSlotNumber({ used, requested: 9 }));

    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.outOfRange);
  });

  it('上限の判定を重複判定より先に行う', () => {
    // 3件埋まっている状態で「スロット2は使用中」とだけ返すと、
    // 他のスロットなら入ると読めてしまう
    const used = [occupancy(1), occupancy(2), occupancy(3)];
    const error = catchError(() => resolveSlotNumber({ used, requested: 2 }));

    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.limitReached);
  });
});
