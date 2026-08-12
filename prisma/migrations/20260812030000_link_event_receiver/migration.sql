-- クリック受信API（D-12・Q-001 の再決定）のための列。
--
-- リダイレクタを Bunshin の共通ドメインから**各ブログのドメイン**へ移す。
-- **30ブログが同一の外部ドメインへリンクすると、運営者の同一性を示す
-- 痕跡になる**（Q-001 再決定 2026-08-11）。計測の一元化より footprint の
-- 回避を優先する。
--
-- ## 1. `blogs.link_event_token_hash`
--
-- 受信APIの認証。**ハッシュだけを持つ。** Bunshin は照合しかしないので、
-- 原文を持つ理由が無い（`admin_login_tokens` と同じ）。
--
-- **`UNIQUE`。** 受信APIはこの1列でブログを引く — **トークンがブログを
-- 決めるので、他ブログのイベントを名乗れない**（完了条件）。
--
-- `link_event_token_issued_at` は画面用。原文は二度と出せないので、
-- 「発行済みか」はこの列で示す。
--
-- ## 2. `banners.code`
--
-- **バナーも案件と同じ `/go/{code}` を通す**（Q-032）。別の経路を作ると
-- クリックの数え方が2つになり、どちらが正しいのかを後から確かめられない。
--
-- 既存行には 22 文字の base64url を割り当てる（`affiliate_links.code` と
-- 同じ形・128ビット）。**推測できない値にする** — 連番にすると、
-- 他ブログのバナーのクリックを外から水増しできる。
--
-- ## 3. `link_clicks` にバナーを受け入れる
--
-- `affiliate_link_id` を nullable にし、`banner_id` を足す。
--
-- **どちらか片方だけが入る**ことを CHECK 制約で強制する。
-- 両方 NULL の行は何のクリックか分からず、両方入った行は
-- **案件とバナーの両方で数えられてしまう**（G-4・G-6 の集計が狂う）。
-- アプリ層だけに置くと、受信APIの経路が増えたときに抜ける。

-- AlterTable（既存行にコードを割り当ててから NOT NULL にする）
ALTER TABLE "banners" ADD COLUMN "code" TEXT;

-- `gen_random_bytes` は pgcrypto が要る。**拡張の有無に依存しない**書き方にする
UPDATE "banners"
   SET "code" = left(
         translate(
           encode(sha256((gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'base64'),
           '+/=', '-_'
         ), 22);

ALTER TABLE "banners" ALTER COLUMN "code" SET NOT NULL;

-- AlterTable
ALTER TABLE "blogs" ADD COLUMN     "link_event_token_hash" TEXT,
ADD COLUMN     "link_event_token_issued_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "link_clicks" ADD COLUMN     "banner_id" UUID,
ALTER COLUMN "affiliate_link_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "banners_code_key" ON "banners"("code");

-- CreateIndex
CREATE UNIQUE INDEX "blogs_link_event_token_hash_key" ON "blogs"("link_event_token_hash");

-- CreateIndex
CREATE INDEX "link_clicks_banner_id_clicked_at_idx" ON "link_clicks"("banner_id", "clicked_at");

-- AddForeignKey
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_banner_id_fkey" FOREIGN KEY ("banner_id") REFERENCES "banners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint（**どちらか片方だけ。** Prisma が表現できないため直接書く）
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_target_exactly_one"
  CHECK (("affiliate_link_id" IS NOT NULL) <> ("banner_id" IS NOT NULL));
