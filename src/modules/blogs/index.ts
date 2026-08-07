/**
 * blogs モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `blogs` テーブルを触ってよいのはこのモジュールだけ。
 *
 * **IDだけでブログを引く関数は公開しない**（SPEC 14.1）。
 * 全ての取得・更新は `userId` を伴う。
 */

export {
  listBlogsForUser,
  findBlogForUser,
  requireBlogForUser,
  createBlogForUser,
  updateBlogForUser,
  closeBlogForUser,
  getSlotUsageForUser,
} from './repository';

export {
  ownedBy,
  requireFound,
  notFoundError,
  BLOG_ERROR_CODES,
} from './ownership';

export {
  BLOG_SLOT_NUMBERS,
  BLOG_SLOT_ERROR_CODES,
  MAX_BLOGS_PER_USER,
  availableSlots,
  isBlogSlotNumber,
  resolveSlotNumber,
} from './slots';

export type { BlogSlotNumber, BlogSlotOccupancy, BlogSlotUsage } from './slots';

export type { AppBlog, CreateBlogInput, UpdateBlogInput } from './types';
