import type {
  EmojiLevel,
  KnowledgeLevel,
  LineBreakStyle,
  PersonaLimitsJson,
  PersonaStatus,
  PersonaType,
} from './personas-api';

/**
 * 分身の画面に出す日本語表記（D-14）。
 *
 * enum をそのまま出さない。`CHARACTER` と表示されても、モニターには
 * 何のことか分からない（`labels.ts` と同じ方針）。
 */

export const PERSONA_TYPE_LABELS: Record<PersonaType, string> = {
  SELF: '自分そのまま',
  IDEAL: 'なりたい自分',
  CHARACTER: '作った人物',
};

export const PERSONA_STATUS_LABELS: Record<PersonaStatus, string> = {
  DRAFT: '下書き',
  ACTIVE: '使用中',
  PAUSED: '休止中',
  ARCHIVED: '終了',
};

export const EMOJI_LEVEL_LABELS: Record<EmojiLevel, string> = {
  none: '使わない',
  low: '少なめ',
  mid: 'ふつう',
};

export const LINE_BREAK_LABELS: Record<LineBreakStyle, string> = {
  short: 'こまめに改行',
  normal: 'ふつう',
};

export const KNOWLEDGE_LEVEL_LABELS: Record<KnowledgeLevel, string> = {
  beginner: 'はじめて',
  intermediate: 'ある程度知っている',
  advanced: '詳しい',
};

export const PERSONA_TYPE_VALUES = [
  'SELF',
  'IDEAL',
  'CHARACTER',
] as const satisfies readonly PersonaType[];

export const EMOJI_LEVEL_VALUES = [
  'none',
  'low',
  'mid',
] as const satisfies readonly EmojiLevel[];

export const LINE_BREAK_VALUES = [
  'short',
  'normal',
] as const satisfies readonly LineBreakStyle[];

export const KNOWLEDGE_LEVEL_VALUES = [
  'beginner',
  'intermediate',
  'advanced',
] as const satisfies readonly KnowledgeLevel[];

/**
 * いま使える枠の説明文（D-14）。
 *
 * **「上限です」だけにしない。** 待てば開くのか、止めれば開くのか、
 * そもそも開かないのかで、モニターが次に取る行動が変わる。
 *
 * | 状況 | 出す文 |
 * |---|---|
 * | 空きがある | あと何体使えるか |
 * | 経過日数で止まっていて、まだ開く | **あと何日で開くか** |
 * | 経過日数で止まっていて、もう開かない | 休止すれば入れ替えられること |
 * | 全体の上限（3体） | 休止すれば入れ替えられること |
 */
export function describePersonaLimits(limits: PersonaLimitsJson): string {
  const remaining = limits.allowedNow - limits.active;

  if (remaining > 0) {
    return `いま ${limits.active} / ${limits.allowedNow} 体を使っています（あと ${remaining} 体）`;
  }

  if (limits.allowedNow < limits.max && limits.nextUnlockInDays !== null) {
    return `いま使えるのは ${limits.allowedNow} 体までです。あと ${limits.nextUnlockInDays} 日で ${limits.allowedNow + 1} 体目が使えるようになります`;
  }

  return `いま使えるのは ${limits.allowedNow} 体までです。入れ替えるには、どれかを休止してください`;
}
