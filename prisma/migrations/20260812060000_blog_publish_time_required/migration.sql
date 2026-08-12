-- 公開時刻を必須にする（TASKS C-9-schema-2）。
--
-- ## なぜ2回に分けたのか
--
-- C-9-schema で `publish_time` を **nullable** で足した。割り当てる処理は
-- コード側（C-9）にあり、列を足した時点ではまだ動いていなかったためである。
-- C-9 が入った今、**新しいブログは必ず割り当てを持つ**ので `NOT NULL` にする。
--
-- A-2-R の「足す → 移す → 消す」と同じ形で、**どの段でもCIが緑のまま**進む。
--
-- ## なぜ `NOT NULL` にするのか
--
-- `publish_time` が空のブログは、**投稿ジョブから見て「いつ公開するか
-- 決まっていない」。** 読む側は必ず「空だったらどうするか」を書くことになり、
-- そこに既定値（9時など）を置けば、**割り当てを忘れた行が
-- 「9時のブログ」として紛れる**（C-9-schema で既定値を置かなかったのと
-- 同じ理由）。落とすなら**保存の時点で落とす。**
--
-- ## 既定値は付けない
--
-- `SET NOT NULL` だけで、`DEFAULT` は付けない。既定値があると、
-- **割り当てを通さない経路（生SQL・テストの補助関数）が黙って通る。**
-- 散らすものに既定値は無い。
--
-- ## 残った NULL の埋め方
--
-- C-9-schema と C-9 の間に作られた行は、まだ空のままでありうる。
-- **C-9-schema と同じ式で埋める** — `id` から決まる値なので、
-- 同じ行には同じ値が入り、**2回流しても結果が変わらない。**
--
-- `publish_weekdays` も同時に埋める（時刻だけあって曜日が空だと、
-- 結局いつも公開されない）。**曜日を空にできない制約はここでは足さない** —
-- 完了条件は `publish_time` の `NOT NULL` で、制約は別に起票した
-- （C-9-schema-3）。1つのマイグレーションで2つのことを決めない。

-- 残った NULL を埋める（**C-9-schema と同じ式**）
UPDATE "blogs"
   SET "publish_weekdays" = CASE (hashtext("id"::text) % 3 + 3) % 3
                              WHEN 0 THEN ARRAY[1, 4]
                              WHEN 1 THEN ARRAY[2, 5]
                              ELSE ARRAY[3, 6]
                            END,
       "publish_time" = (
         '09:00:00'::time + ((hashtext("id"::text || 'h') % 6 + 6) % 6) * interval '1 hour'
       )
 WHERE "publish_time" IS NULL;

-- 曜日だけが空の行を埋める（時刻はあるが曜日が無いと、いつも公開されない）
UPDATE "blogs"
   SET "publish_weekdays" = CASE (hashtext("id"::text) % 3 + 3) % 3
                              WHEN 0 THEN ARRAY[1, 4]
                              WHEN 1 THEN ARRAY[2, 5]
                              ELSE ARRAY[3, 6]
                            END
 WHERE COALESCE(array_length("publish_weekdays", 1), 0) = 0;

-- AlterTable
ALTER TABLE "blogs" ALTER COLUMN "publish_time" SET NOT NULL;
