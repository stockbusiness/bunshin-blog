-- 事実誤認の記録項目と、抜き取り確認の記録（2026-08-17 の決定）
--
-- 決めた運用（`docs/VALIDATION.md` 2.2）：
--
-- > 事実誤認は、運営管理者が毎週1回まとめて登録する。重大な誤りは
-- > 発見時に即時登録する。モニターはLINEで報告するだけとし、
-- > 公開済み記事についても毎週一定数を抽出確認する。
--
-- ## なぜ3列足すのか
--
-- 決定が求める記録項目のうち、**発見経路・修正状況・修正完了日時**が
-- `fact_issues` に無い。
--
-- **発見経路**が無いと、「機械が見逃したのか」「人が抜き取りで見つけたのか」
-- 「読者に指摘されたのか」を分けられない。**打つ手がまったく違う。**
--
-- **修正状況**が無いと、記録した誤りが直ったかどうかを追えない。
-- **記録しただけで直っていない**のがいちばん悪い。
--
-- ## なぜ抜き取り確認の表を足すのか
--
-- **`fact_issues` が空のとき、それが「誤りが無かった」のか
-- 「確かめていない」のかが分からない。**
--
-- これは `fact_issues` 自身が解いた問題（見逃しがどこにも残らない）と
-- **同じ形**である。確認したという事実を残さないかぎり、
-- 空の表は読めない。`metrics_daily` の「行が無い＝未報告」（Q-059）と
-- 同じ考えで、**確認した週にだけ行を作る。**

-- CreateEnum
CREATE TYPE "FactIssueSource" AS ENUM (
  -- モニターがLINEで知らせてきた
  'MONITOR_REPORT',
  -- 運営が抜き取り確認で見つけた
  'SAMPLING',
  -- 運営がそれ以外の場面で気づいた
  'OPERATOR',
  -- 読者からの指摘
  'READER',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "FactIssueFixStatus" AS ENUM (
  'NOT_STARTED',
  'IN_PROGRESS',
  'FIXED',
  -- 直さないと決めた（案件が終了した、など）
  'WONT_FIX'
);

-- AlterTable
ALTER TABLE "fact_issues" ADD COLUMN "found_via" "FactIssueSource";

-- **いままでの行は経路が分からない。** `OTHER` にする
UPDATE "fact_issues" SET "found_via" = 'OTHER';

-- **既定値を置かない。** どこから見つかったかは、
-- 記録するたびに分かっているはずのもの
ALTER TABLE "fact_issues" ALTER COLUMN "found_via" SET NOT NULL;

-- **こちらは既定値を置く。** `NOT_STARTED` は「まだ何もしていない」で、
-- 書き忘れた経路が黙って「直った」ことにはならない
-- （Q-060 で `partnership_status` に既定値を置かなかったのとは逆の理由）
ALTER TABLE "fact_issues"
  ADD COLUMN "fix_status" "FactIssueFixStatus" NOT NULL DEFAULT 'NOT_STARTED';

ALTER TABLE "fact_issues" ADD COLUMN "fixed_at" TIMESTAMPTZ(6);

-- **直したなら、いつ直したかが要る。** 逆は縛らない
-- （直している途中で時刻が入っていても害が無い）
ALTER TABLE "fact_issues"
  ADD CONSTRAINT "fact_issues_fixed_needs_time_check"
  CHECK ("fix_status" <> 'FIXED' OR "fixed_at" IS NOT NULL);

CREATE INDEX "fact_issues_fix_status_idx" ON "fact_issues"("fix_status");
CREATE INDEX "fact_issues_found_via_idx" ON "fact_issues"("found_via");

-- CreateTable
--
-- **確認した週にだけ行を作る。** 行が無い週＝確認していない
CREATE TABLE "fact_review_weeks" (
    "id" UUID NOT NULL,
    -- JSTの月曜（`metrics_daily.metric_date` と同じ扱い。Q-031）
    "week_start" DATE NOT NULL,
    -- その週に確かめた記事の数
    "reviewed_count" INTEGER NOT NULL,
    -- そのうち誤りが見つかった数。**0 を記録できることが要点**
    "issue_count" INTEGER NOT NULL,
    "note" TEXT,
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fact_review_weeks_pkey" PRIMARY KEY ("id")
);

-- **1週に1行。** 同じ週へ入れ直したら上書きする
CREATE UNIQUE INDEX "fact_review_weeks_week_start_key"
  ON "fact_review_weeks"("week_start");

-- **確かめていないのに行を作らせない**（0件は「確認していない」の意）
ALTER TABLE "fact_review_weeks"
  ADD CONSTRAINT "fact_review_weeks_reviewed_positive_check"
  CHECK ("reviewed_count" > 0);

-- **見つけた数が確かめた数を超えない**
ALTER TABLE "fact_review_weeks"
  ADD CONSTRAINT "fact_review_weeks_issue_within_reviewed_check"
  CHECK ("issue_count" >= 0 AND "issue_count" <= "reviewed_count");

-- **確認した人を消しても記録は残す**（確かめた事実は消えない）
ALTER TABLE "fact_review_weeks"
  ADD CONSTRAINT "fact_review_weeks_reviewed_by_user_id_fkey"
  FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
