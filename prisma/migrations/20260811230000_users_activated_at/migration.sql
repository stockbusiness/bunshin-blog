-- 参加開始日の起点（OPEN_QUESTIONS Q-034、ROADMAP 5章）。
--
-- created_at では代用できない。登録しただけでは INVITED のままでアプリを
-- 使えず（H-1）、承認までは何も始まらない。created_at を起点にすると、
-- 承認待ちが長い人ほど早く分身の枠が開く。
--
-- ここを起点にするもの：段階解放、90日検証の期間、8週間継続率。
-- 3つとも同じ列を見るので、ずれるならまとめてずれる。

ALTER TABLE "users" ADD COLUMN "activated_at" TIMESTAMPTZ(6);
