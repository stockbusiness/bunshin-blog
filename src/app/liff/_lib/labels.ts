import type { BlogPurpose, BlogStatus } from './blogs-api';

/**
 * 画面に出す日本語表記（B-5）。
 *
 * enum の値をそのまま出さない。`AFFILIATE` と表示されても、
 * モニターには何のことか分からない。
 */

export const PURPOSE_LABELS: Record<BlogPurpose, string> = {
  AFFILIATE: 'アフィリエイト中心',
  DISPLAY_AD: '広告収益中心',
  MIXED: '両方',
};

export const STATUS_LABELS: Record<BlogStatus, string> = {
  SETUP: '準備中',
  ACTIVE: '稼働中',
  PAUSED: '休止中',
  CLOSED: '終了',
};

/** 設定画面で選べる状態。`CLOSED` は設定画面から選ばせない（SPEC 13.2） */
export const SELECTABLE_STATUSES = ['SETUP', 'ACTIVE', 'PAUSED'] as const;

export const PURPOSE_VALUES = [
  'AFFILIATE',
  'DISPLAY_AD',
  'MIXED',
] as const satisfies readonly BlogPurpose[];
