-- WordPress側で利用者が編集したことを検出した時刻（C-5・DATA_MODEL 11章）。
--
-- 記事本文の正本は「最後に更新されたもの」だが、判定は時刻の比較では行わない。
-- **AIのリライトは常に後から実行される**ため、単純な時刻比較では利用者の
-- 修正が必ず失われる。
--
-- 判定は `last_content_hash` との一致で行い、一致しない場合に
-- 「利用者が編集した」として **WordPress側を正とし**、この列へ検出時刻を残す。
--
-- NULL は「利用者の編集を検出していない」を表す。

-- AlterTable
ALTER TABLE "wordpress_posts" ADD COLUMN     "user_edited_at" TIMESTAMPTZ(6);
