/**
 * 設定を読んでAIプロバイダーを組み立てる（TASKS H-10）。
 *
 * **`createAiProvider()` を直接呼ばない。** 引数を省くと `process.env` を
 * 見るため、**管理画面で設定したAPIキーやモデル名が効かない**。
 * 呼ぶ側が毎回 `getRuntimeEnv()` を渡すのを覚えている前提にせず、
 * 覚えなくてよい入口をここに置く。
 *
 * `src/lib/ai` からは設定を読めない（`src/lib` は `src/modules` を
 * import しない。MODULE_RULES 冒頭）。だから向きはこちらになる。
 */

import { createAiProvider, type AiProvider } from '@/lib/ai';
import { getRuntimeEnv } from './resolve';

export async function createConfiguredAiProvider(
  options: {
    fetchFn?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
    baseUrl?: string | undefined;
  } = {},
): Promise<AiProvider> {
  return createAiProvider({ env: await getRuntimeEnv(), ...options });
}
