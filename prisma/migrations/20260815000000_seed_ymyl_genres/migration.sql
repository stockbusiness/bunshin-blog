-- YMYL ジャンルの種（SPEC 9.2.2、OPEN_QUESTIONS Q-049）
--
-- **`genres` が空だと、段7は選ぶ対象が存在しない。** そのうえ
-- `ymyl_risk` は `genres` マスタの値なので（利用者の申告ではない・
-- `step1.ts`）、**何を HIGH として入れるかが、そのまま停止条件の実体になる。**
--
-- ここで入れるのは **SPEC 9.2.2 の停止条件に列挙された分野だけ**
-- 「YMYL該当（医療・健康効果・投資・融資・保険・法律・就労）」。
-- **解釈を足していない。** 何が YMYL かの線引き（SPEC 18章の未確定事項 11）
-- は決まっていないため、**書いてあるものだけを入れる。**
--
-- **通すためのジャンルはここに入れない。** 実際に何を書くかは案件と
-- 対になって決まる（案件0件は停止条件）。ADMIN が後から足す。
--
-- `status` は `APPROVED`。**審査を経て「これは止める」と決まっている**
-- という意味で、候補ではない。
--
-- 名前が既にあれば何もしない。migrate は何度流れても同じ結果になる。

INSERT INTO "genres" ("id", "name", "category", "competition_level", "ymyl_risk", "notes", "status", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), '医療・健康', '医療・健康', 'HIGH', 'HIGH', 'SPEC 9.2.2 の停止条件「医療・健康効果」', 'APPROVED', now(), now()),
  (gen_random_uuid(), '投資・資産運用', '投資・資産運用', 'HIGH', 'HIGH', 'SPEC 9.2.2 の停止条件「投資」', 'APPROVED', now(), now()),
  (gen_random_uuid(), '融資・ローン', '融資・ローン', 'HIGH', 'HIGH', 'SPEC 9.2.2 の停止条件「融資」', 'APPROVED', now(), now()),
  (gen_random_uuid(), '保険', '保険', 'HIGH', 'HIGH', 'SPEC 9.2.2 の停止条件「保険」', 'APPROVED', now(), now()),
  (gen_random_uuid(), '法律', '法律', 'HIGH', 'HIGH', 'SPEC 9.2.2 の停止条件「法律」', 'APPROVED', now(), now()),
  (gen_random_uuid(), '就労・転職', '就労・転職', 'HIGH', 'HIGH', 'SPEC 9.2.2 の停止条件「就労」', 'APPROVED', now(), now())
ON CONFLICT ("name") DO NOTHING;
