import type { Metadata } from 'next';
import { LiffProvider } from './_components/liff-provider';

/**
 * `/liff` 配下の共通レイアウト（TASKS B-8）。
 *
 * ここで LIFF の初期化とセッション確立を済ませるため、配下の画面
 * （B-5・F-4・F-5・G-5・H-2）は認証済みの前提で書ける。
 */

export const metadata: Metadata = {
  title: 'BUNSHIN BLOG',
};

export default function LiffLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <LiffProvider>{children}</LiffProvider>;
}
