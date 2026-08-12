-- 公開曜日を空にできなくする（TASKS C-9-schema-3）。
--
-- ## なぜ `publish_time` の NOT NULL だけでは足りないのか
--
-- C-9-schema-2 で公開時刻は必須になった。しかし **`publish_weekdays` が
-- 空の行は、時刻があっても一度も公開されない。**
--
-- 投稿ジョブは「今日がこのブログの公開曜日か」を見て動く。空の配列は
-- どの曜日にも当たらないので、**ブログは `ACTIVE` のまま、記事は溜まり、
-- 何も出ない。** 止まっていることが誰にも見えない壊れ方になる。
--
-- 時刻を必須にしたのと同じ理由で、曜日も空を許さない。
--
-- ## なぜ NOT NULL ではなく CHECK なのか
--
-- PostgreSQL の配列列は、**`NOT NULL` にしても空配列 `{}` を弾かない。**
-- `NULL` と「要素が0個」は別物である。塞ぎたいのは後者なので CHECK を使う。
--
-- ## 曜日の範囲（0〜6）はここでは見ない
--
-- 7 のような値も「どの曜日にも当たらない」という意味では同じ壊れ方をするが、
-- **完了条件は「空のまま保存できない」。** 1つのマイグレーションで2つを
-- 決めない（C-9-schema-2 で曜日の制約を分けたのと同じ）。範囲の制約が
-- 要ると判断したら、別タスクとして起票する。
--
-- ## 既存行の埋め方
--
-- C-9-schema・C-9-schema-2 と**同じ式**（`id` から決まる値）で埋める。
-- ランダムにすると、同じ移行を2回流したときに別の値になる。

-- 空の行を埋める（**C-9-schema と同じ式**）
UPDATE "blogs"
   SET "publish_weekdays" = CASE (hashtext("id"::text) % 3 + 3) % 3
                              WHEN 0 THEN ARRAY[1, 4]
                              WHEN 1 THEN ARRAY[2, 5]
                              ELSE ARRAY[3, 6]
                            END
 WHERE COALESCE(array_length("publish_weekdays", 1), 0) = 0;

-- **空配列も NULL も弾く。** `array_length` は空配列に対して NULL を返す
ALTER TABLE "blogs" ADD CONSTRAINT "blogs_publish_weekdays_not_empty"
  CHECK (COALESCE(array_length("publish_weekdays", 1), 0) >= 1);
