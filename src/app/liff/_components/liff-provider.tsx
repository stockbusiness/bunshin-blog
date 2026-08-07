'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import {
  bootstrapLiffSession,
  type LiffBootstrapResult,
  type LiffClient,
} from '@/lib/liff';

/**
 * LIFF の初期化を1か所で行う（TASKS B-8）。
 *
 * `/liff` 配下の全画面はこれに包まれる。各画面が個別に `liff.init()` を
 * 呼ぶと、初期化の重複と失敗時の扱いのばらつきが必ず出る。
 *
 * **手順そのものは `@/lib/liff` の純粋関数に置いてある。** ここは
 * 実SDKの読み込みと描画だけを担当する。
 */

type LiffState = LiffBootstrapResult | { status: 'loading' };

const LiffContext = createContext<LiffState>({ status: 'loading' });

/** 画面から現在のLIFF状態を読む。`ready` の中でのみ使うこと */
export function useLiffSession(): LiffState {
  return useContext(LiffContext);
}

/**
 * SDK をブラウザでだけ読み込む。
 *
 * `@line/liff` は `window` を前提とするため、サーバー側の描画に
 * 巻き込まれないよう動的 import にする。
 */
async function loadLiffClient(): Promise<LiffClient> {
  const sdk = await import('@line/liff');

  return sdk.default as unknown as LiffClient;
}

export function LiffProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [state, setState] = useState<LiffState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let result: LiffBootstrapResult;

      try {
        const liff = await loadLiffClient();
        result = await bootstrapLiffSession({ liff });
      } catch {
        result = {
          status: 'init-error',
          message:
            'LIFFの読み込みに失敗しました。LINEアプリから開き直してください',
        };
      }

      // 遷移後の setState を避ける
      if (!cancelled) {
        setState(result);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading' || state.status === 'redirecting') {
    return <LiffNotice title="読み込んでいます" />;
  }

  if (state.status !== 'ready') {
    return <LiffNotice title="開けませんでした" detail={state.message} />;
  }

  return <LiffContext value={state}>{children}</LiffContext>;
}

/**
 * 初期化前・失敗時に出す画面。
 *
 * **スマートフォンの縦画面を前提にする**（SPEC 6.1 の利用者画面は
 * 全てLIFF）。文字を詰め込まず、次に取れる行動だけを書く。
 */
function LiffNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <p className="text-base font-bold">{title}</p>
      {detail === undefined ? null : (
        <p className="mt-3 text-sm leading-relaxed">{detail}</p>
      )}
    </main>
  );
}
