-- 事実誤認の記録（TASKS J-7、OPEN_QUESTIONS Q-044、SPEC 16.2）
--
-- 「承認・公開前に100%検知」を確かめるための分母。
-- これまで記録されていたのは機械が見つけたものだけで、
-- 見逃したものはどこにも残らなかった。

CREATE TYPE "IssueSeverity" AS ENUM ('MAJOR', 'MINOR');

CREATE TABLE "fact_issues" (
    "id" UUID NOT NULL,
    "article_version_id" UUID NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "caught_before_publish" BOOLEAN NOT NULL,
    "found_at" TIMESTAMPTZ(6) NOT NULL,
    "found_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fact_issues_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fact_issues_article_version_id_idx" ON "fact_issues"("article_version_id");

-- 分子と分母をこの1本で引く（重大なものを公開前に捕まえられたか）
CREATE INDEX "fact_issues_caught_before_publish_severity_idx" ON "fact_issues"("caught_before_publish", "severity");

-- 記事の版を消せば記録も消える（版が無ければ、どこの誤りか分からない）
ALTER TABLE "fact_issues" ADD CONSTRAINT "fact_issues_article_version_id_fkey"
    FOREIGN KEY ("article_version_id") REFERENCES "article_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 見つけた人を消しても記録は残す。誤りがあった事実は消えない
ALTER TABLE "fact_issues" ADD CONSTRAINT "fact_issues_found_by_user_id_fkey"
    FOREIGN KEY ("found_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 中身の無い記録を残さない（「何か誤りがあった」だけでは数えられても直せない）
ALTER TABLE "fact_issues" ADD CONSTRAINT "fact_issues_description_not_empty"
    CHECK (length(btrim("description")) > 0);
