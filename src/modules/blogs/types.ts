/**
 * blogs モジュールが外部へ渡すブログ表現（B-3）。
 *
 * Prisma の型をそのまま外へ出さない（users と同じ方針）。
 */
export interface AppBlog {
  id: string;
  userId: string;
  name: string;
  slug: string;
  targetReader: string;
  penName: string | null;
  purpose: 'AFFILIATE' | 'DISPLAY_AD' | 'MIXED';
  status: 'SETUP' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
  slotNumber: number;
  launchDate: Date | null;
  createdAt: Date;
}

/** 新規作成の入力。`userId` は含めない（セッションから取る） */
export interface CreateBlogInput {
  name: string;
  slug: string;
  targetReader: string;
  slotNumber: number;
  penName?: string | undefined;
  purpose?: AppBlog['purpose'] | undefined;
}

/** 更新の入力。指定した項目のみ変える */
export interface UpdateBlogInput {
  name?: string | undefined;
  slug?: string | undefined;
  targetReader?: string | undefined;
  penName?: string | null | undefined;
  purpose?: AppBlog['purpose'] | undefined;
  status?: Exclude<AppBlog['status'], 'CLOSED'> | undefined;
}
