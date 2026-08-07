-- CreateTable
CREATE TABLE "admin_login_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_login_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_login_tokens_token_hash_key" ON "admin_login_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "admin_login_tokens_user_id_created_at_idx" ON "admin_login_tokens"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_login_tokens_expires_at_idx" ON "admin_login_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "admin_login_tokens" ADD CONSTRAINT "admin_login_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 有効期限は必ず発行時より後。DATA_MODEL 4章に従い、取り違えると
-- 事故になるものはDB側にも入れる。期限切れのトークンを発行しても
-- 「なぜかログインできない」としか分からず、原因の切り分けが難しい
ALTER TABLE "admin_login_tokens" ADD CONSTRAINT "admin_login_tokens_expiry_after_creation"
  CHECK ("expires_at" > "created_at");

-- 使用時刻は発行より後。時刻がずれた環境で入れ違いに書かれるのを防ぐ
ALTER TABLE "admin_login_tokens" ADD CONSTRAINT "admin_login_tokens_used_after_creation"
  CHECK ("used_at" IS NULL OR "used_at" >= "created_at");
