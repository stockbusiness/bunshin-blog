/**
 * content-generation モジュールの型（TASKS E-2、SPEC 6.2）。
 *
 * 本タスクで扱うのは `prompt_versions` のみ。`article_versions` は E-10。
 */

export interface AppPromptVersion {
  id: string;
  /** プロンプトの種類（`article.body` など） */
  key: string;
  /** 版。`key` の中で一意 */
  version: string;
  body: string;
  /** この版が使われているか。**1つの `key` につき1つまで** */
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePromptVersionInput {
  key: string;
  version: string;
  body: string;
  notes?: string | undefined;
  /** 作成と同時に有効化するか。既定は `false` */
  activate?: boolean | undefined;
}
