import { AppError } from '@/lib/errors';
import type { AppBlog } from './types';

/**
 * ブログ枠（slot）の制御（B-4）。
 *
 * - SPEC 2.5「1ユーザー当たりブログ：最大3件」
 * - DATA_MODEL 4章「`UNIQUE(user_id, slot_number)`」「`CHECK(slot_number BETWEEN 1 AND 3)`」
 * - OPEN_QUESTIONS Q-008「`CLOSED` にしたスロットは再利用できない」
 *
 * **このファイルはDBに触らない。** 使用中スロットの取得は `repository.ts` が行い、
 * その結果をここへ渡す。判定を純粋関数に切り出しておくことで、
 * 「4件目」「重複」「CLOSED の再利用」を実DBを起こさずに固定できる。
 */

/** 使えるスロット番号。DBの `CHECK(slot_number BETWEEN 1 AND 3)` と一致させる */
export const BLOG_SLOT_NUMBERS = [1, 2, 3] as const;

export type BlogSlotNumber = (typeof BLOG_SLOT_NUMBERS)[number];

/**
 * 1ユーザーが持てるブログの上限（SPEC 2.5）。
 *
 * **スロット数から導く。** 別々に定数を置くと、片方だけ変えたときに
 * 「上限は3だがスロットは4つある」のような矛盾が静かに入る。
 */
export const MAX_BLOGS_PER_USER = BLOG_SLOT_NUMBERS.length;

/** slot 制御のエラーコード */
export const BLOG_SLOT_ERROR_CODES = {
  /** 3件すべて使用済み */
  limitReached: 'BLOG_LIMIT_REACHED',
  /** 指定したスロットが埋まっている（`CLOSED` を含む） */
  slotTaken: 'BLOG_SLOT_TAKEN',
  /** 1〜3 以外を指定した */
  outOfRange: 'BLOG_SLOT_OUT_OF_RANGE',
} as const;

/** 1つのスロットの使用状況 */
export interface BlogSlotOccupancy {
  slotNumber: BlogSlotNumber;
  blogId: string;
  status: AppBlog['status'];
}

/** ユーザー1人ぶんのスロット使用状況（B-5・H-2 の残枠表示で使う） */
export interface BlogSlotUsage {
  /** 上限。常に `MAX_BLOGS_PER_USER` */
  limit: number;
  /** 使用中のスロット。`CLOSED` を含む（Q-008） */
  used: BlogSlotOccupancy[];
  /** 空きスロット番号 */
  available: BlogSlotNumber[];
  /** 空き数。`available.length` と同じ */
  remaining: number;
}

/** 数値が 1〜3 のスロット番号か */
export function isBlogSlotNumber(value: number): value is BlogSlotNumber {
  return (BLOG_SLOT_NUMBERS as readonly number[]).includes(value);
}

/**
 * 空いているスロット番号。
 *
 * **`CLOSED` のスロットは空きに含めない**（Q-008）。閉じたブログも
 * スロットを保持し続けるため、`(user_id, slot_number)` が期間を通じた
 * 識別子として安定する。
 */
export function availableSlots(
  used: readonly BlogSlotOccupancy[],
): BlogSlotNumber[] {
  const taken = new Set(used.map((entry) => entry.slotNumber));

  return BLOG_SLOT_NUMBERS.filter((slot) => !taken.has(slot));
}

function occupancyOf(
  used: readonly BlogSlotOccupancy[],
  slotNumber: BlogSlotNumber,
): BlogSlotOccupancy | undefined {
  return used.find((entry) => entry.slotNumber === slotNumber);
}

/** 3件すべて埋まっている */
export function limitReachedError(
  used: readonly BlogSlotOccupancy[],
): AppError {
  return new AppError(
    BLOG_SLOT_ERROR_CODES.limitReached,
    409,
    `ブログは最大${String(MAX_BLOGS_PER_USER)}件までです`,
    {
      details: {
        limit: MAX_BLOGS_PER_USER,
        used: used.map((entry) => entry.slotNumber).sort((a, b) => a - b),
      },
    },
  );
}

/**
 * 指定したスロットが埋まっている。
 *
 * `CLOSED` の場合はメッセージを分ける。「閉じたのだから空いたはず」と
 * 受け取られると、モニターが同じ操作を繰り返すだけになる。
 */
export function slotTakenError(params: {
  slotNumber: BlogSlotNumber;
  closed: boolean;
}): AppError {
  const message = params.closed
    ? `スロット${String(params.slotNumber)}は閉じたブログが使用しています。スロットは再利用できません`
    : `スロット${String(params.slotNumber)}は既に使われています`;

  return new AppError(BLOG_SLOT_ERROR_CODES.slotTaken, 409, message, {
    // blogId は返さない。閉じたブログのIDを知らせる必要が無い
    details: { slotNumber: params.slotNumber, closed: params.closed },
  });
}

/** 1〜3 以外を指定した */
export function slotOutOfRangeError(requested: number): AppError {
  return new AppError(
    BLOG_SLOT_ERROR_CODES.outOfRange,
    422,
    `スロット番号は1〜${String(MAX_BLOGS_PER_USER)}で指定してください`,
    { details: { requested } },
  );
}

/**
 * 新しいブログに割り当てるスロット番号を決める。
 *
 * `requested` を省略すると、**空いている最も小さい番号**を割り当てる。
 * 省略できるようにしてあるのは、クライアントが自力で空きを計算できないため。
 * 一覧APIは `CLOSED` を既定で返さないので、クライアントから見ると
 * 「空いているはずのスロット」と実際の空きがずれる（Q-008）。
 *
 * @throws {AppError} 上限到達（409）／重複（409）／範囲外（422）
 */
export function resolveSlotNumber(params: {
  used: readonly BlogSlotOccupancy[];
  requested?: number | undefined;
}): BlogSlotNumber {
  const { used, requested } = params;

  if (requested !== undefined && !isBlogSlotNumber(requested)) {
    throw slotOutOfRangeError(requested);
  }

  const free = availableSlots(used);

  // 上限の判定を重複より先に行う。3件埋まっている状態で
  // 「スロット2が使用中」とだけ返すと、他を試せば入ると読めてしまう
  if (free.length === 0) {
    throw limitReachedError(used);
  }

  if (requested === undefined) {
    // free.length > 0 は上で確かめている
    return free[0] as BlogSlotNumber;
  }

  const occupied = occupancyOf(used, requested);
  if (occupied !== undefined) {
    throw slotTakenError({
      slotNumber: occupied.slotNumber,
      closed: occupied.status === 'CLOSED',
    });
  }

  return requested;
}
