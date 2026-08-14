import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,

  /**
   * Cloud Run 用の自己完結した出力（Q-045）。
   *
   * `.next/standalone` に `server.js` と**実際に読み込まれる依存だけ**が
   * 出る。`Dockerfile` の最終段はこれを写す。
   */
  output: 'standalone',
};

export default nextConfig;
