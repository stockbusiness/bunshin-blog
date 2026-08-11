-- Search Console の連携をサービスアカウントに切り替える（OPEN_QUESTIONS Q-030）。
--
-- ブログごとの refresh_token を保存しない。サービスアカウントの秘密鍵は
-- app_settings の暗号化列に1つだけ置き、モニターは Search Console の画面で
-- そのアドレスに権限を渡す。ブログごとの行が持つのは property_url と接続状態だけ。
--
-- この列に行は入っていない（G-1 が未実装のため）。

ALTER TABLE "search_console_connections" DROP COLUMN "refresh_token_encrypted";
