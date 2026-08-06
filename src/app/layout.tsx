import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BUNSHIN BLOG',
  description: 'LINE承認型AI編集長',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
