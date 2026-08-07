/**
 * Next.js のサーバー起動時に一度だけ実行される。
 * 環境変数が不足していればメッセージを出して起動を中止する（TASKS A-3）。
 */
export async function register(): Promise<void> {
  // Edge Runtime では Node.js 前提の環境変数が揃わないため検証しない
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { getServerEnv, EnvValidationError } = await import('@/lib/env');

  try {
    getServerEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) {
      throw error;
    }

    // 例外を投げるだけではプロセスが起動したまま残るため、明示的に終了する。
    // 変数名のみを出力し、値は出さない（SPEC 14.2）。
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
