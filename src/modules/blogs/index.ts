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

export { findGenre, listSelectableGenres } from './genres';

export {
  ownedBy,
  requireFound,
  notFoundError,
  BLOG_ERROR_CODES,
} from './ownership';

export {
  countBlogsByUserForAdmin,
  toBlogCounts,
  EMPTY_BLOG_COUNT,
  type AdminBlogCount,
  type BlogStatusCountRow,
} from './admin-counts';

export {
  BLOG_SLOT_NUMBERS,
  BLOG_SLOT_ERROR_CODES,
  MAX_BLOGS_PER_USER,
  availableSlots,
  isBlogSlotNumber,
  resolveSlotNumber,
} from './slots';

export type { BlogSlotNumber, BlogSlotOccupancy, BlogSlotUsage } from './slots';

export {
  DEFAULT_ARTICLE_RATIO,
  WEEKLY_PUBLISH_CAP_MAX,
  WEEKLY_PUBLISH_CAP_MIN,
  DEFAULT_WEEKLY_PUBLISH_CAP,
  ARTICLE_RATIO_ERROR_CODES,
  parseArticleRatio,
  withWeeklyPublishCap,
} from './article-ratio';

export type { ArticleRatio } from './article-ratio';

export type {
  AppBlog,
  AppBlogGenre,
  AppGenre,
  CreateBlogInput,
  UpdateBlogInput,
} from './types';

export {
  generateLinkEventToken,
  hashLinkEventToken,
  issueLinkEventTokenForUser,
  findBlogIdByLinkEventToken,
} from './link-event-token';

export {
  PUBLISH_WEEKDAY_SETS,
  PUBLISH_HOUR_MIN,
  PUBLISH_HOUR_COUNT,
  PUBLISH_JITTER_MAX_MIN,
  INITIAL_ARTICLE_MIN,
  INITIAL_ARTICLE_COUNT_RANGE,
  PERMALINK_PATTERNS,
  PERMALINK_PATHS,
  assignPublishSchedule,
  toPublishTimeColumn,
  fromPublishTimeColumn,
  type PermalinkPattern,
  type PublishSchedule,
} from './publish-schedule';
