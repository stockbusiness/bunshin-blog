-- ブログ単位の指標が重複しないようにする（TASKS G-5）。
--
-- `metrics_daily` の一意インデックスは `(blog_id, content_item_id, metric_date)`
-- だが、**PostgreSQL は NULL 同士を「違う値」として扱う。** 記事に紐づかない
-- 行（`content_item_id IS NULL`）は、同じブログの同じ日でも何行でも入る。
--
-- 手動の収益入力（G-5）はブログ単位で記録するため、ここがそのまま効く。
-- **重複した行は集計（G-6）で二重に数えられ、しかも気づけない。**
--
-- PostgreSQL 15 以降の `NULLS NOT DISTINCT` で、NULL を含む組でも一意にする。
-- **アプリ側の書き方に頼らない**（C-6 と同じ筋）。
--
-- インデックスとして張り直す（Prisma が作った形と同じにして、
-- スキーマとの差分検査に引っかからないようにする）。
DROP INDEX "metrics_daily_blog_id_content_item_id_metric_date_key";

CREATE UNIQUE INDEX "metrics_daily_blog_id_content_item_id_metric_date_key"
  ON "metrics_daily" (blog_id, content_item_id, metric_date)
  NULLS NOT DISTINCT;
