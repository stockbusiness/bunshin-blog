-- 管理画面から変更できる設定（H-7-schema、OPEN_QUESTIONS Q-017）。
--
-- ## 秘密が平文の列に入らないことを、DBで保証する
--
-- `is_secret` と値の入り先が食い違うと、**APIキーが平文で保存されたまま
-- 誰も気づかない**。アプリ側の書き方に任せると、入口が増えたときに漏れる。
--
--   is_secret = true  → value は NULL、value_encrypted に入る
--   is_secret = false → value に入る、value_encrypted は NULL
--
-- どちらの場合も**値そのものは必須**。片方だけ NULL の中途半端な行を
-- 作れないようにする（「設定したのに効かない」の原因になる）。
--
-- ## 消すときは行ごと消す
--
-- 「値を空にする」を許すと、`is_secret = true` で `value_encrypted` が
-- NULL の行が生まれる。設定を解除したいときは行を削除する
-- （解決順が環境変数・コード既定へ落ちる）。
--
-- ## `key` は一意だが主キーではない
--
-- DATA_MODEL 1章「主キーは全て uuid」に合わせる。一意性は unique 索引で保つ。
--
-- ## `updated_by_user_id` は SetNull
--
-- 誰が変えたかは分かるほうがよいが、**参照先が消えても設定は残す**
-- （DATA_MODEL 2章の監査系と同じ扱い）。Phase 0 では利用者を物理削除しない。

-- CreateTable
CREATE TABLE "app_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "value_encrypted" TEXT,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_key_key" ON "app_settings"("key");

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 秘密が平文の列に入らないことを強制する
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_secret_column"
  CHECK (
    (is_secret AND value IS NULL AND value_encrypted IS NOT NULL)
    OR
    (NOT is_secret AND value IS NOT NULL AND value_encrypted IS NULL)
  );

-- 設定名の形。環境変数と同じ綴りにして、解決順を追いやすくする
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_format"
  CHECK (key ~ '^[A-Z][A-Z0-9_]*$');
