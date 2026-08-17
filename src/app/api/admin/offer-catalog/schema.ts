import { z } from 'zod';
import type { CatalogItemInput } from '@/modules/affiliate';

/**
 * 案件の元の入力（Q-055）。
 *
 * **足切りの値もここで受ける**（SPEC 9.2.3）。登録の時点で分かって
 * いれば、モニターが選んだあとで止めずに済む。
 *
 * **`as const` の並びをここに置く。** モジュール側の配列は型が広く、
 * `z.enum` に渡すと文字列型に落ちる（`offers/route.ts` と同じ形）。
 */

const CONVERSION_TYPES = [
  'FREE_SIGNUP',
  'REQUEST',
  'TRIAL',
  'PURCHASE',
  'OTHER',
] as const;

const LINK_MODES = ['DIRECT', 'REDIRECT'] as const;

const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const;

export const catalogItemSchema = z.object({
  name: z.string().min(1).max(200),
  aspName: z.string().min(1).max(100),
  advertiserName: z.string().max(200).nullable().optional(),
  landingPageUrl: z.string().url().max(2_000),
  rewardYen: z.number().int().min(0).max(10_000_000).nullable().optional(),
  conversionType: z.enum(CONVERSION_TYPES),
  /** 1行に1つ（Q-050）。**運営が確かめたもの** */
  facts: z.array(z.string().trim().min(1).max(200)).max(50),
  denyConditions: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  linkMode: z.enum(LINK_MODES).optional(),
  subIdParam: z.string().max(50).nullable().optional(),
  blogPostingProhibited: z.boolean().optional(),
  lpFormFields: z.number().int().min(0).max(100).nullable().optional(),
  lpMobileReady: z.boolean().nullable().optional(),
  genreHints: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  notes: z.string().max(1_000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
}) satisfies z.ZodType<CatalogItemInput, unknown>;
